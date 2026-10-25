# Melissa Downloader API 🐢

API HTTP em Node.js nativo, sem Express e sem dependências npm externas. Suporta vídeos do TikTok via TikWM e vídeos do YouTube via `yt-dlp`, transmitindo o conteúdo diretamente ao cliente sem salvar o vídeo inteiro em disco ou na memória.

## Endpoints

- `GET /` e `GET /health`: verificação de saúde.
- `POST /download`: extrai e transmite um vídeo.

O endpoint exige o secret `API_KEY` e o cabeçalho `X-API-Key`.

### Exemplo de requisição

```http
POST /download
Content-Type: application/json
X-API-Key: SUA_CHAVE
```

TikTok:
```json
{"url":"https://www.tiktok.com/@usuario/video/1234567890"}
```

YouTube:
```json
{"url":"https://www.youtube.com/watch?v=ID_DO_VIDEO"}
```

A resposta bem-sucedida é o vídeo binário. O servidor usa o fluxo HTTP nativo, sem dividir manualmente a resposta em blocos de 64 KB. O limite do vídeo é 500 MiB para TikTok; o YouTube é transmitido em fluxo, sem arquivo temporário, e depende da disponibilidade de um formato MP4 que já contenha áudio e vídeo juntos.

## Executar localmente

Requisitos: Node.js 20 ou superior, `yt-dlp` instalado e acessível no `PATH` para downloads do YouTube.

```bash
git clone https://github.com/chirusanrestart/melissa-downloader-api.git
cd melissa-downloader-api
API_KEY="sua-chave-de-teste" PORT=8000 npm start
```

Para o YouTube, o servidor chama `yt-dlp` com `--js-runtimes node` e `--remote-components ejs:github`. O runtime Node.js não substitui o executável `yt-dlp`; ambos precisam estar disponíveis.

## Docker e Hostless

O Dockerfile instala o executável Linux standalone oficial do `yt-dlp` e usa Node.js 22. A aplicação escuta em `0.0.0.0:8000`; o Hostless deve encaminhar tráfego para a porta 8000 e verificar `/health`.

Configure `API_KEY` em Secrets no Hostless. Não coloque chaves reais no Git.

## Limitações

- TikTok depende da API externa TikWM.
- A extração do YouTube pode falhar se o YouTube alterar seus mecanismos, se o runtime Node.js não estiver disponível, ou se o formato combinado MP4 não existir para o vídeo.
- A saída direta do `yt-dlp` é intencional: se ocorrer erro depois do início do vídeo, a conexão será encerrada para não apresentar um arquivo parcial como completo.
- Use apenas conteúdo que você tem autorização para baixar.
