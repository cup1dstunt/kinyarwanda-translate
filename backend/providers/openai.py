from .base import Provider, ProviderError


class OpenAI(Provider):
    name = "openai"

    def translate(self, text, source, target):
        data = self._post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": self._prompt(source, target)},
                    {"role": "user", "content": text},
                ],
            },
        )
        try:
            return data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError) as exc:
            raise ProviderError("openai: unerwartete Antwort") from exc
