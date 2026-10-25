import json
import sys
from pinterest_dl import PinterestDL


def main():
    request = json.load(sys.stdin)
    query = str(request.get("query", "")).strip()[:200]
    max_results = max(1, min(60, int(request.get("max", 20))))

    if not query:
        raise ValueError("A consulta de pesquisa está vazia")

    # ApiScraper.search exige min_resolution; (0, 0) não filtra por tamanho.
    media = PinterestDL.with_api(timeout=10, verbose=False).search(
        query=query,
        num=max_results,
        min_resolution=(0, 0),
        delay=0.4,
    )

    print(json.dumps(
        [item.to_dict() for item in media[:max_results]],
        ensure_ascii=False
    ))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"pinterest-dl: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
