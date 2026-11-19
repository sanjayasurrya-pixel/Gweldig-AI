import os
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client, Client

# Cari lokasi folder tempat file db.py ini berada
env_path = Path(__file__).resolve().parent / ".env"

# Muat file .env berdasarkan jalur pasti (absolute path)
load_dotenv(dotenv_path=env_path)

url: str = os.getenv("SUPABASE_URL")
key: str = os.getenv("SUPABASE_KEY")

if not url or not key:
    raise ValueError(
        f"Gagal membaca kredensial Supabase!\n"
        f"Lokasi .env yang dicari: {env_path}\n"
        f"Apakah file ada di lokasi tersebut?: {env_path.exists()}\n"
        f"SUPABASE_URL: {url}\n"
        f"SUPABASE_KEY: {'Ada' if key else 'Kosong'}"
    )

supabase: Client = create_client(url, key)