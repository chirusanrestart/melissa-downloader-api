---
title: Melissa Downloader API
emoji: 🐢
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: API para baixar e transmitir mídia em blocos
---

# Melissa Downloader API 🐢

Servidor HTTP em Python para o Chiru-san Bot. Recebe um link de uma plataforma permitida, usa `yt-dlp` para extrair a mídia e transmite o arquivo para o bot em blocos de **64 KiB**, sem salvar o vídeo inteiro em disco ou carregar o arquivo completo na RAM do servidor.

## Endpoints

- `GET /`: informações básicas e endpoints.
- `GET /health`: estado do serviço e quantidade de tarefas pendentes.
- `POST /extract`: compatibilidade com clientes antigos; retorna os metadados e o link direto.
- `POST /download`: extrai e transmite o arquivo binário diretamente ao cliente em blocos de 64 KiB.

Os endpoints POST exigem o cabeçalho `X-API-Key` e um corpo JSON:

```http
POST /download
Content-Type: application/json
X-API-Key: SUA_CHAVE
```

```json
{"url":"https://exemplo.com/video"}
```

Em caso de sucesso, `/download` responde com o arquivo binário. Os cabeçalhos `X-Media-Title`, `X-Media-Ext` e `X-Stream-Chunk-Size` informam o título, a extensão e o tamanho-alvo dos blocos. A resposta é transmitida em streaming e não é armazenada como arquivo no servidor.

O limite de mídia padrão é 150 MiB e o timeout do download é configurável. Ajuste o limite conforme os recursos do serviço e o uso permitido pelo provedor de hospedagem.

## Executar localmente

Requisitos: Python, `yt-dlp`, Deno para recursos JavaScript usados por algumas plataformas e as dependências em `requirements.txt`.

```bash
git clone https://github.com/chirusanrestart/melissa-downloader-api.git
cd melissa-downloader-api
python -m pip install -r requirements.txt
python -m pip install -U yt-dlp
export OWNER_API_KEY='defina-uma-chave-forte'
export FRIEND_API_KEY='defina-outra-chave-forte'
export PORT=10000
python app.py
```

Configure `OWNER_API_KEY` e `FRIEND_API_KEY` como variáveis secretas no painel do provedor. Não coloque chaves reais no GitHub.

## Variáveis de ambiente

| Variável | Finalidade |
| --- | --- |
| `OWNER_API_KEY` | Chave principal, com prioridade na fila |
| `FRIEND_API_KEY` | Segunda chave de API |
| `PORT` | Porta HTTP, padrão `10000` |
| `MAX_QUEUE` | Limite de tarefas de extração pendentes |
| `EXTRACT_TIMEOUT` | Tempo limite da extração, em segundos |
| `MEDIA_TIMEOUT` | Tempo limite de cada leitura do arquivo, em segundos |
| `ALLOWED_DOMAINS` | Domínios de origem permitidos, separados por vírgula |
| `LOG_LEVEL` | Nível de log |
| `PYTHON` | Executável Python usado para chamar `yt-dlp` |
| `YTDLP_IMPERSONATE` | Impersonação opcional, se suportada |

## Integração com o bot

No `src/services/melissaDownloader.js`, o bot chama `/download` e grava o corpo recebido diretamente em `downloads/` por streaming. A configuração `MELISSA_DOWNLOADER_API_URL` pode apontar para `https://melissa-downloader-api.onrender.com/download`; a integração também converte automaticamente o caminho antigo `/extract` em `/download`.

O bot e o servidor mantêm um limite de 150 MiB por arquivo. O arquivo local é então entregue ao fluxo existente de envio do WhatsApp.

## Uso responsável

Use somente conteúdo que você tem autorização para acessar. Respeite os termos das plataformas, direitos autorais e privacidade. A disponibilidade depende da plataforma e de alterações no próprio serviço.
