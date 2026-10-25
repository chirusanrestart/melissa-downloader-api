# Melissa Downloader API 🐢

API HTTP em Node.js nativo, sem Express e sem dependências npm externas. Suporta vídeos do TikTok via TikWM, vídeos do YouTube e Instagram via `yt-dlp`, e pesquisa de pins no Pinterest usando a biblioteca dedicada `pinterest-dl`. O conteúdo de vídeo é transmitido diretamente ao cliente, sem salvar o vídeo inteiro em disco ou na memória.

## Endpoints

- `GET /` e `/health`: verificação de saúde.
- `POST /download`: extrai e transmite um vídeo do TikTok, YouTube ou Instagram.
- `POST /pinterest/search`: pesquisa pins no Pinterest usando `pinterest-dl` em modo API, sem instalar navegador.

Todos os endpoints POST exigem o secret `API_KEY` e o cabeçalho `X-API-Key`.

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

Instagram Reel público:
```json
{"url":"https://www.instagram.com/reel/C3EW2ipRfpg/"}
```

A resposta bem-sucedida é o vídeo binário. O servidor transmite pelo fluxo HTTP nativo, sem dividir manualmente a resposta em blocos de 64 KB. O limite do vídeo é 500 MiB para TikTok; o YouTube é transmitido em fluxo, sem arquivo temporário, e depende da disponibilidade de um formato MP4 que já contenha áudio e vídeo juntos.

### Pinterest: pesquisar pins

```http
POST /pinterest/search
Content-Type: application/json
X-API-Key: SUA_CHAVE
```

```json
{"query":"anime wallpaper","max":20}
```

A resposta é JSON com `count` e `results`, incluindo os metadados e URLs disponibilizados por `pinterest-dl`. O limite é de 1 a 60 resultados por pedido. Essa rota pesquisa pins e devolve metadados/links, não transmite um arquivo de imagem como a rota `/download`. A pesquisa tem timeout de 45 segundos e limite de 2 MiB para a resposta interna.

## Executar localmente

Requisitos: Node.js 20 ou superior e Python 3. O Dockerfile instala `yt-dlp`, `curl_cffi` e `pinterest-dl` no mesmo ambiente Python. O Pinterest usa o modo API da biblioteca, sem Playwright/Chromium.

```bash
git clone https://github.com/chirusanrestart/melissa-downloader-api.git
cd melissa-downloader-api
API_KEY="sua-chave-de-teste" PORT=8000 npm start
```

Para o YouTube, o servidor chama `yt-dlp` com `--js-runtimes node` e `--remote-components ejs:github`. O runtime Node.js não substitui o executável `yt-dlp`; ambos precisam estar disponíveis.

## Docker e Hostless

O Dockerfile instala as dependências Python no ambiente virtual `/opt/venv` e usa Node.js 22. A aplicação escuta em `0.0.0.0:8000`; o Hostless deve encaminhar tráfego para a porta 8000 e verificar `/health`.

Configure `API_KEY` nos Secrets do Hostless. Não coloque chaves reais no Git.

## Limitações

- TikTok depende da API externa TikWM.
- A extração do Instagram pode falhar se a publicação não for pública, exigir login ou o Instagram bloquear a requisição mesmo com impersonação.
- A pesquisa do Pinterest depende da disponibilidade da API usada pela biblioteca `pinterest-dl` e pode ser limitada pelo próprio Pinterest.
- A extração do YouTube pode falhar se o YouTube alterar seus mecanismos, se o runtime Node.js não estiver disponível, ou se o formato combinado MP4 não existir para o vídeo.
- A saída direta do `yt-dlp` é intencional: se ocorrer erro depois do início do vídeo, a conexão será encerrada para não apresentar um arquivo parcial como completo.
- Use apenas conteúdo que você tem autorização para baixar.
