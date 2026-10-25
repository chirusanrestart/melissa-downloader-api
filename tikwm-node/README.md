# Protótipo Node.js + TikWM

Este diretório é um teste isolado e **não substitui a API Python atual** do repositório.

## Rodar no Hostless

- Diretório de trabalho: `tikwm-node` (se o painel permitir configurar subdiretório).
- Start command: `npm start`
- Configure o secret `API_KEY` com uma chave forte.
- Configure `PORT` se o Hostless não fornecer automaticamente.
- Requer Node.js 20+.

Se o Hostless executar apenas a raiz do repositório, não altere a configuração de produção por enquanto: copie estes três arquivos para um serviço de teste separado ou ajuste o diretório de trabalho no painel.

## Testar

Health check: `GET /health`

Envie um pedido para `POST /download` com os cabeçalhos `Content-Type: application/json` e `X-API-Key: SUA_CHAVE`, e o corpo:

```json
{"url":"https://www.tiktok.com/@usuario/video/1234567890"}
```

A resposta é o vídeo binário transmitido diretamente ao cliente. O código não grava o vídeo em disco nem o carrega inteiro na RAM. O limite é 500 MiB. A API exige `API_KEY` configurada; sem ela, o endpoint de download recusa pedidos.

## Observações

- O TikWM é um serviço externo gratuito cuja disponibilidade e limites podem mudar.
- Use apenas conteúdo que você tem autorização para baixar.
- Este protótipo não foi validado em produção; teste primeiro com um vídeo público curto.
