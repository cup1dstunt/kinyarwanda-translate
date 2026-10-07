import os


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def max_input_chars() -> int:
    return int(env("MAX_INPUT_CHARS", "2000"))
