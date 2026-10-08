import httpx


def describe(exc: httpx.HTTPStatusError) -> str:
    """HTTP-Status plus die Fehlermeldung des Anbieters (Google, Anthropic und OpenAI nutzen error.message)."""
    status = f"HTTP {exc.response.status_code}"
    try:
        error = exc.response.json().get("error", {})
        message = error.get("message") if isinstance(error, dict) else str(error)
    except ValueError:
        message = ""
    return f"{status}: {message[:200]}" if message else status
