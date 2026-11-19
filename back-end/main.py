import os
import asyncio
import base64
import locale
from datetime import datetime
from typing import List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai
from google.genai import types

from db import supabase

# Load environment variables
load_dotenv()

# Set locale waktu ke Bahasa Indonesia (jika didukung OS)
try:
    locale.setlocale(locale.LC_TIME, "id_ID.utf8")
except Exception:
    try:
        locale.setlocale(locale.LC_TIME, "Indonesian")
    except Exception:
        pass

# Inisialisasi FastAPI
app = FastAPI(title="AI Assistant API")

# Konfigurasi CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Konfigurasi Gemini API
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not GEMINI_API_KEY:
    raise ValueError("GEMINI_API_KEY tidak ditemukan di file .env!")

gemini_client = genai.Client(api_key=GEMINI_API_KEY)

# Nil UUID valid untuk sesi dev tanpa autentikasi
DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000000"


# ==========================================
# MODEL DATA PYDANTIC
# ==========================================

class Attachment(BaseModel):
    name: str
    mime_type: str = "application/octet-stream"
    data: str


class ChatRequest(BaseModel):
    message: str = ""
    project_id: Optional[str] = "default"
    attachments: Optional[List[Attachment]] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    max_output_tokens: Optional[int] = None
    top_p: Optional[float] = None


class TaskRequest(BaseModel):
    task: str


class ProjectRequest(BaseModel):
    name: str


# ==========================================
# ENDPOINT CHAT & HISTORY
# ==========================================

AVAILABLE_MODELS = [
    {"id": "gemini-2.0-flash", "label": "Gemini 2.0 Flash"},
    {"id": "gemini-2.0-flash-lite", "label": "Gemini 2.0 Flash Lite"},
    {"id": "gemini-1.5-flash", "label": "Gemini 1.5 Flash"},
    {"id": "gemini-1.5-flash-8b", "label": "Gemini 1.5 Flash 8B"},
    {"id": "gemini-1.5-pro", "label": "Gemini 1.5 Pro"},
]


@app.get("/models")
async def get_models():
    return {"models": AVAILABLE_MODELS}


def _decode_attachment_data(data: str) -> bytes:
    if not data:
        return b""
    if "," in data and data.strip().startswith("data:"):
        data = data.split(",", 1)[1]
    return base64.b64decode(data)


def _build_attachment_note(attachments: Optional[List[Attachment]]) -> str:
    if not attachments:
        return ""
    names = [a.name for a in attachments if a and a.name]
    if not names:
        return ""
    return "\n\n[Lampiran: " + ", ".join(names) + "]"


@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    user_message = (request.message or "").strip()
    attachments = request.attachments or []
    if not user_message and not attachments:
        raise HTTPException(status_code=400, detail="Pesan atau lampiran tidak boleh kosong")

    project_id = str(request.project_id) if request.project_id else "default"

    try:
        attachment_note = _build_attachment_note(attachments)
        stored_user_message = user_message if user_message else "(Lampiran tanpa pesan teks)"
        stored_user_message = stored_user_message + attachment_note

        # 1. Simpan pesan user ke Supabase (opsional)
        try:
            await asyncio.to_thread(
                lambda: supabase.table("chat_history")
                .insert({
                    "user_id": DEFAULT_USER_ID,
                    "project_id": project_id,
                    "role": "user",
                    "message": stored_user_message
                })
                .execute()
            )
        except Exception as db_err:
            print(f"Gagal menyimpan pesan user ke database: {db_err}")

        # 2. Ambil riwayat percakapan sebelumnya (Maksimal 10 pesan terakhir untuk konteks AI)
        raw_history = []
        try:
            history_response = await asyncio.to_thread(
                lambda: supabase.table("chat_history")
                .select("role, message")
                .eq("user_id", DEFAULT_USER_ID)
                .eq("project_id", project_id)
                .order("created_at", desc=True)
                .limit(10)
                .execute()
            )
            raw_history = (history_response.data or [])[::-1]  # Urutkan kembali dari yang tertua
        except Exception as db_err:
            print(f"Gagal mengambil riwayat dari database: {db_err}")

        formatted_history = ""
        for h in raw_history[:-1]:  # Kecuali pesan terbaru yang baru diinsert
            role_label = "Pengguna" if h.get("role") == "user" else "Asisten"
            formatted_history += f"{role_label}: {h.get('message')}\n"

        # 3. Ambil daftar tugas harian dari Supabase sebagai konteks AI
        tasks = []
        try:
            tasks_response = await asyncio.to_thread(
                lambda: supabase.table("daily_tasks")
                .select("*")
                .eq("user_id", DEFAULT_USER_ID)
                .execute()
            )
            tasks = tasks_response.data or []
        except Exception as db_err:
            print(f"Gagal mengambil tugas dari database: {db_err}")

        if tasks:
            task_context = ""
            for t in tasks:
                status = "Selesai" if t.get("is_completed") else "Belum Selesai"
                task_context += f"- [ID {t.get('id')}] {t.get('task')} (Status: {status})\n"
        else:
            task_context = "Pengguna belum memiliki daftar tugas harian saat ini.\n"

        # 4. Waktu real-time server
        now = datetime.now()
        current_time_str = now.strftime("%A, %d %B %Y - %H:%M WIB")

        # 5. Susun System Prompt
        prompt = (
            f"Kamu adalah asisten AI serbaguna yang ramah, cerdas, dan responsif.\n\n"
            f"INFORMASI WAKTU SAAT INI (REAL-TIME):\n"
            f"- Waktu Server Saat Ini: {current_time_str}\n\n"
            f"KONTEKS TUGAS HARIAN USER SAAT INI:\n{task_context}\n"
            f"RIWAYAT PERCAKAPAN SEBELUMNYA:\n{formatted_history if formatted_history else 'Belum ada riwayat percakapan.'}\n\n"
            f"PANDUAN MERESPONS:\n"
            f"1. Jawab pertanyaan umum user dengan bebas, fleksibel, dan akurat.\n"
            f"2. Gunakan INFORMASI WAKTU SAAT INI jika user bertanya tentang hari, tanggal, atau jam.\n"
            f"3. Jika user bertanya tentang tugas atau agenda, manfaatkan KONTEKS TUGAS HARIAN di atas.\n"
            f"4. Jika ada lampiran gambar atau file, analisis isinya dengan teliti dan jawab sesuai konteks.\n"
            f"5. Selalu gunakan bahasa Indonesia yang ramah, alami, dan membantu.\n\n"
            f"Pesan Pengguna Saat Ini: {user_message if user_message else '(Pengguna mengirim lampiran tanpa teks tambahan.)'}"
        )

        content_parts = [types.Part.from_text(text=prompt)]
        for att in attachments:
            try:
                file_bytes = _decode_attachment_data(att.data)
                if not file_bytes:
                    continue
                mime_type = att.mime_type or "application/octet-stream"
                content_parts.append(
                    types.Part.from_bytes(data=file_bytes, mime_type=mime_type)
                )
            except Exception as att_err:
                print(f"Gagal memproses lampiran {att.name}: {att_err}")

        # 6. Kirim prompt ke Gemini API dengan Model Fallback & Extended Retry
        ai_reply = None
        requested_model = (request.model or "").strip()
        default_fallbacks = [m["id"] for m in AVAILABLE_MODELS] + ["gemini-3.5-flash-lite"]
        if requested_model:
            candidate_models = [requested_model] + [m for m in default_fallbacks if m != requested_model]
        else:
            candidate_models = default_fallbacks

        gen_config = None
        cfg = {}
        if request.temperature is not None:
            cfg["temperature"] = max(0.0, min(2.0, float(request.temperature)))
        if request.max_output_tokens is not None:
            cfg["max_output_tokens"] = max(64, min(8192, int(request.max_output_tokens)))
        if request.top_p is not None:
            cfg["top_p"] = max(0.0, min(1.0, float(request.top_p)))
        if cfg:
            gen_config = types.GenerateContentConfig(**cfg)

        last_exception = None

        for model_name in candidate_models:
            max_retries = 3
            for attempt in range(max_retries):
                try:
                    response = await asyncio.to_thread(
                        lambda m=model_name, c=content_parts, g=gen_config: gemini_client.models.generate_content(
                            model=m,
                            contents=c,
                            config=g,
                        )
                    )
                    ai_reply = response.text
                    break
                except Exception as gemini_err:
                    last_exception = gemini_err
                    err_msg = str(gemini_err)
                    print(f"[Gemini Retry] Model {model_name} Percobaan {attempt+1} Gagal: {err_msg}")

                    # Jika kendala jaringan / 503 / 429 / UNAVAILABLE, tunggu dan coba lagi
                    if any(code in err_msg for code in ["503", "429", "UNAVAILABLE", "RESOURCE_EXHAUSTED"]) and attempt < max_retries - 1:
                        await asyncio.sleep(2 * (attempt + 1))  # Delay 2 detik, 4 detik
                        continue
                    else:
                        break  # Pindah ke model cadangan berikutnya jika retry habis

            if ai_reply:
                break  # Berhasil mendapat balasan, hentikan loop model

        if not ai_reply:
            print(f"Detail Error Utama Gemini API: {last_exception}")
            raise HTTPException(
                status_code=503,
                detail="Layanan AI sedang padat. Silakan coba kirim ulang pesan dalam beberapa detik.",
            )

        # 7. Simpan balasan AI ke Supabase (opsional)
        try:
            await asyncio.to_thread(
                lambda: supabase.table("chat_history")
                .insert({
                    "user_id": DEFAULT_USER_ID,
                    "project_id": project_id,
                    "role": "assistant",
                    "message": ai_reply
                })
                .execute()
            )
        except Exception as db_err:
            print(f"Gagal menyimpan balasan AI ke database: {db_err}")

        return {"reply": ai_reply}

    except HTTPException as http_ex:
        raise http_ex
    except Exception as e:
        print(f"Error pada /chat: {e}")
        raise HTTPException(status_code=500, detail=f"Internal Error: {str(e)}")


@app.get("/history")
async def get_history():
    try:
        response = await asyncio.to_thread(
            lambda: supabase.table("chat_history")
            .select("*")
            .eq("user_id", DEFAULT_USER_ID)
            .order("created_at", desc=False)
            .execute()
        )
        return {"history": response.data or []}
    except Exception as e:
        print(f"Error pada /history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/history")
async def clear_history():
    try:
        await asyncio.to_thread(
            lambda: supabase.table("chat_history")
            .delete()
            .eq("user_id", DEFAULT_USER_ID)
            .execute()
        )
        return {"message": "Riwayat chat berhasil dihapus"}
    except Exception as e:
        print(f"Error pada delete /history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# ENDPOINT PROJECTS / PERCAKAPAN
# ==========================================

@app.get("/projects")
async def get_projects():
    try:
        response = await asyncio.to_thread(
            lambda: supabase.table("projects")
            .select("*")
            .eq("user_id", DEFAULT_USER_ID)
            .order("created_at", desc=True)
            .execute()
        )
        return response.data or []
    except Exception as e:
        print(f"Error pada GET /projects: {e}")
        raise HTTPException(status_code=500, detail=f"Gagal mengambil project: {str(e)}")


@app.post("/projects")
async def create_project(request: ProjectRequest):
    try:
        response = await asyncio.to_thread(
            lambda: supabase.table("projects")
            .insert({"name": request.name.strip(), "user_id": DEFAULT_USER_ID})
            .execute()
        )
        return response.data[0] if response.data else {"message": "Project dibuat"}
    except Exception as e:
        print(f"Error pada POST /projects: {e}")
        raise HTTPException(status_code=500, detail=f"Gagal membuat project: {str(e)}")


@app.get("/projects/{project_id}/messages")
async def get_project_messages(project_id: str):
    try:
        response = await asyncio.to_thread(
            lambda: supabase.table("chat_history")
            .select("*")
            .eq("user_id", DEFAULT_USER_ID)
            .eq("project_id", str(project_id))
            .order("created_at", desc=False)
            .execute()
        )
        
        formatted_messages = [
            {"role": item["role"], "content": item["message"]} 
            for item in (response.data or [])
        ]
        return formatted_messages
    except Exception as e:
        print(f"Error pada GET /projects/{project_id}/messages: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/projects/{project_id}")
async def delete_project(project_id: str):
    try:
        # Hapus riwayat pesan proyek
        await asyncio.to_thread(
            lambda: supabase.table("chat_history")
            .delete()
            .eq("user_id", DEFAULT_USER_ID)
            .eq("project_id", str(project_id))
            .execute()
        )
        # Hapus data proyek
        await asyncio.to_thread(
            lambda: supabase.table("projects")
            .delete()
            .eq("user_id", DEFAULT_USER_ID)
            .eq("id", str(project_id))
            .execute()
        )
        return {"message": "Project berhasil dihapus"}
    except Exception as e:
        print(f"Error pada DELETE /projects/{project_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# ENDPOINT DAILY TASKS
# ==========================================

@app.get("/tasks")
async def get_tasks():
    try:
        response = await asyncio.to_thread(
            lambda: supabase.table("daily_tasks")
            .select("*")
            .eq("user_id", DEFAULT_USER_ID)
            .order("created_at", desc=False)
            .execute()
        )
        return {"tasks": response.data or []}
    except Exception as e:
        print(f"Error pada GET /tasks: {e}")
        raise HTTPException(status_code=500, detail=f"Gagal mengambil tugas: {str(e)}")


@app.post("/tasks")
async def add_task(request: TaskRequest):
    if not request.task.strip():
        raise HTTPException(status_code=400, detail="Nama tugas tidak boleh kosong")

    try:
        response = await asyncio.to_thread(
            lambda: supabase.table("daily_tasks")
            .insert({
                "user_id": DEFAULT_USER_ID, 
                "task": request.task.strip(), 
                "is_completed": False
            })
            .execute()
        )
        return {"message": "Tugas berhasil ditambahkan", "data": response.data}
    except Exception as e:
        print(f"Error pada POST /tasks: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/tasks/{task_id}")
async def toggle_task(task_id: int, is_completed: bool):
    try:
        response = await asyncio.to_thread(
            lambda: supabase.table("daily_tasks")
            .update({"is_completed": is_completed})
            .eq("id", task_id)
            .eq("user_id", DEFAULT_USER_ID)
            .execute()
        )
        return {"message": "Status tugas diperbarui", "data": response.data}
    except Exception as e:
        print(f"Error pada PATCH /tasks/{task_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/tasks/{task_id}")
async def delete_task(task_id: int):
    try:
        await asyncio.to_thread(
            lambda: supabase.table("daily_tasks")
            .delete()
            .eq("id", task_id)
            .eq("user_id", DEFAULT_USER_ID)
            .execute()
        )
        return {"message": "Tugas berhasil dihapus"}
    except Exception as e:
        print(f"Error pada DELETE /tasks/{task_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))