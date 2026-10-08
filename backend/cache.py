"""Übersetzungs-Cache (SQLite): gleiche Anfragen kosten keinen zweiten API-Aufruf."""
import hashlib
import sqlite3

from .users import data_dir


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(data_dir() / "cache.db")
    conn.execute("CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
    return conn


def _key(provider: str, source: str, target: str, text: str) -> str:
    return hashlib.sha256(f"{provider}\0{source}\0{target}\0{text}".encode()).hexdigest()


def get(provider: str, source: str, target: str, text: str) -> str | None:
    with _conn() as conn:
        row = conn.execute("SELECT v FROM t WHERE k = ?", (_key(provider, source, target, text),)).fetchone()
    return row[0] if row else None


def put(provider: str, source: str, target: str, text: str, translation: str) -> None:
    with _conn() as conn:
        conn.execute("INSERT OR REPLACE INTO t VALUES (?, ?)", (_key(provider, source, target, text), translation))
