import time

import httpx

RATES_URL = "https://open.er-api.com/v6/latest/EUR"
CACHE_SECONDS = 3600
_cache: dict = {"at": 0.0, "rate": 0.0}


class CurrencyError(Exception):
    pass


def eur_to_rwf(client: httpx.Client | None = None) -> float:
    """Kurs 1 EUR in RWF, eine Stunde zwischengespeichert."""
    if _cache["rate"] and time.time() - _cache["at"] < CACHE_SECONDS:
        return _cache["rate"]
    try:
        resp = (client or httpx).get(RATES_URL, timeout=10)
        resp.raise_for_status()
        rate = float(resp.json()["rates"]["RWF"])
    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
        raise CurrencyError("Wechselkurs nicht verfügbar") from exc
    _cache.update(at=time.time(), rate=rate)
    return rate


def convert(amount: float, source: str, target: str) -> dict:
    if {source, target} != {"EUR", "RWF"}:
        raise CurrencyError("Nur EUR und RWF werden unterstützt")
    rate = eur_to_rwf()
    result = amount * rate if source == "EUR" else amount / rate
    return {"amount": amount, "from": source, "to": target, "result": round(result, 2), "rate": rate}
