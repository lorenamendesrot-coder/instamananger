# Configuração para rodar sem navegador (cron automático)

O scheduler já está configurado para rodar a cada 1 minuto no Netlify,
mesmo com o navegador fechado e o PC desligado.

Para ativar, você precisa configurar as variáveis de ambiente abaixo
no painel do Netlify.

---

## Passo a passo

### 1. Acesse o painel do seu site no Netlify
https://app.netlify.com → seu site → **Site configuration** → **Environment variables**

### 2. Adicione estas variáveis

| Variável            | Como obter                                                                 |
|---------------------|----------------------------------------------------------------------------|
| `NETLIFY_TOKEN`     | app.netlify.com → clique no seu avatar → **User settings** → **OAuth** → **New access token** |
| `NETLIFY_SITE_ID`   | Painel do site → **Site configuration** → **General** → campo "Site ID"   |
| `VITE_META_APP_ID`  | developers.facebook.com → seu app → ID do aplicativo                      |
| `META_APP_SECRET`   | developers.facebook.com → seu app → Chave secreta do aplicativo           |

> A variável `URL` é preenchida automaticamente pelo Netlify com a URL do seu site.
> Você não precisa adicionar ela manualmente.

### 3. Faça um novo deploy

Após adicionar as variáveis, vá em **Deploys** → **Trigger deploy** → **Deploy site**.

---

## Como funciona após configurar

- O Netlify chama o `scheduler` automaticamente a cada 1 minuto
- Ele lê a fila de posts agendados
- Publica cada conta com 15 segundos de intervalo entre elas (anti-spam)
- Em caso de erro, tenta novamente automaticamente após 10 minutos
- Tudo funciona mesmo com o PC desligado e o navegador fechado

## Limites do plano gratuito

| Recurso               | Limite free     | Seu uso estimado (50 contas, 1 post/hora) |
|-----------------------|-----------------|-------------------------------------------|
| Execuções de cron     | 43.200/mês      | ~43.200/mês (no limite, ok)               |
| Tempo de execução     | 125k GB-h/mês   | ~2k GB-h/mês (bem abaixo)                 |
| Timeout por execução  | 26s             | ~3-5s por conta, escalonado               |

> Para 50 contas postando ao mesmo tempo, o scheduler divide automaticamente
> em slots de 15s cada. 50 contas = 12,5 minutos de janela total, distribuídos
> ao longo dos ticks de 1 minuto do cron.
