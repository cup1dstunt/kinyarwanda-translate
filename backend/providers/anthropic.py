from .base import Provider, ProviderError


class Anthropic(Provider):
    name = "anthropic"

    def translate(self, text, source, target):
        data = self._post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": self.api_key, "anthropic-version": "2023-06-01"},
            json={
                "model": self.model,
                "max_tokens": 2048,
                "system": self._prompt(source, target),
                "messages": [{"role": "user", "content": text}],
            },
        )
        try:
            return data["content"][0]["text"].strip()
        except (KeyError, IndexError) as exc:
            raise ProviderError("anthropic: unerwartete Antwort") from exc
