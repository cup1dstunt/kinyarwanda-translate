from .base import Provider, ProviderError


class GoogleTranslate(Provider):
    name = "google"

    def translate(self, text, source, target):
        data = self._post(
            "https://translation.googleapis.com/language/translate/v2",
            params={"key": self.api_key},
            json={"q": text, "source": source, "target": target, "format": "text"},
        )
        try:
            return data["data"]["translations"][0]["translatedText"]
        except (KeyError, IndexError) as exc:
            raise ProviderError("google: unerwartete Antwort") from exc
