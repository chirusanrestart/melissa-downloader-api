---
title: Melissa Downloader API
emoji: 🐢
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: API para extrair links diretos de mídia
---

# Melissa Downloader API 🐢

Serviço HTTP em Python que recebe um link de uma plataforma compatível e tenta extrair a URL direta do arquivo de mídia usando `yt-dlp`. Foi pensado para funcionar como serviço auxiliar do Chiru-san Bot.

**Importante:** a API extrai e devolve o link direto. O download e o envio do arquivo ficam a cargo do bot ou do cliente que consome a API.

## ✨ Funcionalidades

- 🔗 Extração de links diretos de mídia
- 🎞️ Seleção de formato com preferência por mídia com áudio quando disponível
- ⚙️ Execução do `yt-dlp` com tempo limite configurável
- 🧵 Fila de tarefas para controlar solicitações
- 🔐 Autenticação por chave de API
- 🩺 Endpoint de saúde para verificar o estado do serviço
- 🌐 Lista configurável de domínios permitidos

A extração depende da plataforma de origem, da disponibilidade do conteúdo e das mudanças feitas pelos próprios serviços. Não há garantia de que todo link funcione.

## 📡 Endpoints

### `GET /`

Retorna informações básicas sobre o serviço e os endpoints disponíveis.

### `GET /health`

Retorna o estado do serviço, se as chaves de autenticação estão configuradas e a quantidade de solicitações pendentes.

### `POST /extract`

Extrai um link direto de mídia. Requer o cabeçalho `X-API-Key` e um corpo JSON:

```http
POST /extract
Content-Type: application/json
X-API-Key: SUA_CHAVE
```

Corpo:

```json
{
  "url": "https://exemplo.com/video"
}
```

Em caso de sucesso, a resposta inclui campos como `url`, `title`, `ext`, `has_audio` e, quando necessário, cabeçalhos HTTP para acessar a mídia. A URL retornada pode expirar.

## 🚀 Executar localmente

Requisitos:

- Python
- `yt-dlp`
- Deno para os recursos JavaScript usados por algumas plataformas
- Dependências listadas em `requirements.txt`

Clone o projeto e instale as dependências:

```bash
git clone https://github.com/chirusanrestart/melissa-downloader-api.git
cd melissa-downloader-api
python -m pip install -r requirements.txt
python -m pip install -U yt-dlp
```

Configure as variáveis de ambiente necessárias antes de iniciar:

```bash
export OWNER_API_KEY='defina-uma-chave-forte'
export FRIEND_API_KEY='defina-outra-chave-forte'
export PORT=10000
python app.py
```

Use valores próprios e seguros. Não coloque chaves reais no código ou em arquivos enviados ao GitHub.

## ⚙️ Variáveis de ambiente

| Variável | Finalidade |
| --- | --- |
| `OWNER_API_KEY` | Chave de autenticação com prioridade na fila |
| `FRIEND_API_KEY` | Segunda chave de autenticação |
| `PORT` | Porta HTTP; padrão `10000` |
| `MAX_QUEUE` | Limite de tarefas pendentes |
| `EXTRACT_TIMEOUT` | Tempo limite da extração, em segundos |
| `ALLOWED_DOMAINS` | Lista separada por vírgulas dos domínios aceitos |
| `LOG_LEVEL` | Nível de registro dos logs |
| `PYTHON` | Executável Python usado para chamar o `yt-dlp` |
| `YTDLP_IMPERSONATE` | Configuração opcional de impersonação do `yt-dlp` |

Confira `.env.example` e o código atual antes de implantar, pois os valores padrão podem mudar.

## ☁️ Implantação

O repositório inclui configuração para implantação em serviços compatíveis com aplicações Python. Configure as chaves de API como variáveis secretas no painel do provedor e mantenha o serviço atualizado.

Antes de disponibilizar a API publicamente, revise limites de uso, autenticação, logs e domínios permitidos. Nunca compartilhe uma chave de API em prints ou mensagens públicas.

## 🛡️ Uso responsável

Use o serviço apenas com conteúdo que você tem autorização para acessar. Respeite os termos das plataformas de origem, direitos autorais e a privacidade de terceiros. Não tente acessar conteúdo privado ou protegido sem autorização.

## 👩‍💻 Projeto

Desenvolvido por **Chiru-san** como serviço auxiliar para automação de mídia.
