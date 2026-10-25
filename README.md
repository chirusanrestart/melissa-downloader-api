---
title: Melissa Downloader API
emoji: 🐢
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: API TikTok via TikWM com streaming em blocos
---

# Melissa Downloader API 🐢

API HTTP em **Node.js 22** que usa o serviço externo TikWM para resolver vídeos do TikTok e transmite o conteúdo ao cliente em streaming, sem salvar o vídeo em disco nem carregar o arquivo inteiro na memória.

## Endpoints

- `GET /`: informações básicas do serviço.
- `GET /health`: verificação de saúde.
- `POST /download`: obtém o vídeo pelo TikWM e transmite o binário ao cliente.

O endpoint de download exige o secret `API_KEY` configurado no provedor e o cabeçalho `X-API-Key`.

Exemplo de requisição:

```http
POST /download
Content-Type: application/json
X-API-Key: SUA_CHAVE
```

```json
{"url":"https://www.tiktok.com/@usuario/video/1234567890"}
```

A resposta bem-sucedida é o vídeo binário. O servidor transmite em blocos de até **64 KiB** no fluxo da aplicação e aceita vídeos de até **500 MiB**. Não cria arquivos temporários.

## Executar localmente

Requisitos: Node.js 20 ou superior. Não há dependências npm externas.

```bash
git clone https://github.com/chirusanrestart/melissa-downloader-api.git
cd melissa-downloader-api
npm start
```

Configure a variável de ambiente `API_KEY` antes de disponibilizar o serviço publicamente. O servidor usa a variável `PORT` fornecida pela hospedagem; localmente, o padrão é `7860`.

## Docker e Hostless

O `Dockerfile` usa a imagem oficial `node:22-alpine`. O `hostless.yaml` inicia `node server.js` e verifica `/health`.

## Limitações

- O TikWM é um serviço externo gratuito. Disponibilidade, limites e compatibilidade podem mudar.
- Esta versão resolve links do TikTok via TikWM; ela não inclui mais yt-dlp, FastAPI, Uvicorn, curl_cffi ou Deno.
- Use apenas conteúdo que você tem autorização para baixar.
