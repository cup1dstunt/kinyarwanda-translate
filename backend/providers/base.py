import httpx

LANG_NAMES = {"de": "German", "fr": "French", "rw": "Kinyarwanda"}
LANGUAGES = list(LANG_NAMES)

SYSTEM_PROMPT = (
    "You are a translation engine. Translate the user's text from {source} to {target}. "
    "Output only the translation, no explanations. Keep the tone and formatting of the original."
)


class ProviderError(Exception):
    pass


class Provider:
    name = ""

    def __init__(self, api_key: str, model: str = "", client: httpx.Client | None = None):
        self.api_key = api_key
        self.model = model
        self.client = client or httpx.Client(timeout=30)

    def translate(self, text: str, source: str, target: str) -> str:
        raise NotImplementedError

    def _post(self, url: str, **kwargs) -> dict:
        try:
            resp = self.client.post(url, **kwargs)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPError as exc:
            raise ProviderError(f"{self.name}: {exc.__class__.__name__}") from exc

    def _prompt(self, source: str, target: str) -> str:
        return SYSTEM_PROMPT.format(source=LANG_NAMES[source], target=LANG_NAMES[target])
