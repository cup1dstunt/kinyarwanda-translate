from .base import Provider, ProviderError


class Gemini(Provider):
    name = "gemini"

    def translate(self, text, source, target):
        data = self._post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent",
            headers={"x-goog-api-key": self.api_key},
            json={
                "systemInstruction": {"parts": [{"text": self._prompt(source, target)}]},
                "contents": [{"role": "user", "parts": [{"text": text}]}],
            },
        )
        try:
            return data["candidates"][0]["content"]["parts"][0]["text"].strip()
        except (KeyError, IndexError) as exc:
            raise ProviderError("gemini: unerwartete Antwort") from exc
