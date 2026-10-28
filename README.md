# Melissa Downloader API 🐢

API HTTP em Node.js nativo, sem Express. Para vídeos do TikTok, tenta primeiro o TikWM e, se ele falhar, usa `yt-dlp` como fallback no servidor. YouTube e Instagram também usam `yt-dlp`; a pesquisa de pins do Pinterest usa `pinterest-dl`. O conteúdo de vídeo é transmitido diretamente ao cliente, sem salvar o vídeo inteiro em disco ou na memória.

## Endpoints

- `GET /` e `/health`: verificação de saúde.
- `POST /download`: extrai e transmite mídia do TikTok, YouTube ou Instagram; no YouTube aceita `mode: audio` ou `mode: video`.
- `POST /youtube/search`: pesquisa um nome no YouTube e devolve metadados do primeiro resultado em JSON.
- `POST /youtube/playlist`: lê os itens de uma playlist do YouTube e devolve até 100 URLs e títulos em JSON.
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

As rotas `/youtube/search` e `/youtube/playlist` retornam JSON; a playlist é limitada a 100 itens por chamada. A resposta bem-sucedida de `/download` é a mídia binária. O servidor transmite pelo fluxo HTTP nativo, sem dividir manualmente a resposta em blocos de 64 KB. O limite do vídeo é 500 MiB para TikTok; o YouTube é transmitido em fluxo, sem arquivo temporário, e depende da disponibilidade de um formato MP4 que já contenha áudio e vídeo juntos.

### Conversão de mídia na nuvem

Os comandos do Chiru San Bot podem usar estas rotas autenticadas para enviar a mídia em base64 e receber o arquivo convertido como resposta binária:

- `POST /media/sticker`: imagem para figurinha WebP 512×512; com `animated: true`, usa FFmpeg para criar figurinha animada de até 10 segundos.
- `POST /media/toimg`: WebP de entrada para PNG.
- `POST /media/hd`: realça uma imagem JPEG com o perfil solicitado: `balanced`, `anime`, `sharp`, `vivid`, `natural` ou `beauty`.

Exemplo de corpo JSON para `/media/hd`:

```json
{"data":"BASE64_DA_IMAGEM","profile":"vivid"}
```

Para `/media/sticker`, use `{"data":"BASE64_DA_MIDIA","animated":false}`. Para `/media/toimg`, basta enviar `{"data":"BASE64_DA_FIGURINHA_WEBP"}`. O limite de entrada é 12 MiB por mídia. Todas as rotas POST exigem `X-API-Key`. O bot pode recorrer ao processamento local se a API estiver indisponível.

## Pinterest: pesquisar pins

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

- TikTok tenta primeiro a API externa TikWM e usa `yt-dlp` no servidor se o TikWM falhar. O fallback requer que o executável `yt-dlp` e os componentes de runtime necessários estejam instalados no ambiente Hostless.
- A extração do Instagram pode falhar se a publicação não for pública, exigir login ou o Instagram bloquear a requisição mesmo com impersonação.
- A pesquisa do Pinterest depende da disponibilidade da API usada pela biblioteca `pinterest-dl` e pode ser limitada pelo próprio Pinterest.
- A extração do YouTube pode falhar se o YouTube alterar seus mecanismos, se o runtime Node.js não estiver disponível, ou se o formato combinado MP4 não existir para o vídeo.
- A saída direta do `yt-dlp` é intencional: se ocorrer erro depois do início do vídeo, a conexão será encerrada para não apresentar um arquivo parcial como completo.
- Use apenas conteúdo que você tem autorização para baixar.
