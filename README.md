# Barbearia do Jota — versão Cloudflare Workers

A Cloudflare **não executa o `server.js`** (ele é para servidores Node). Esta versão tem a mesma interface e as mesmas regras,
mas a API roda **dentro da própria Cloudflare** (Worker + Durable Object com banco SQLite embutido). Tudo continua em **um único domínio**.

## Publicar (uma vez só)
**Atalho:** dê dois cliques em `publicar.bat` (Windows) ou rode `./publicar.sh` (Mac/Linux). Não use o carregador de arquivos do painel da Cloudflare: ele só aceita sites estáticos e não publica a API.

1. Instale o Node.js 18+ (https://nodejs.org).
2. Abra um terminal **dentro desta pasta** e rode:
   ```
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
3. O comando mostra o endereço (algo como `https://barbeariadojota.SEU-USUARIO.workers.dev`).
   Como o nome do projeto é o mesmo (`barbeariadojota`), ele **substitui** o site que você já tinha publicado.

> Para trocar o e-mail/senha do admin já na criação, adicione `"vars": { "ADMIN_EMAIL": "voce@email.com", "ADMIN_PASSWORD": "sua-senha" }` ao `wrangler.jsonc` **antes do primeiro acesso**.
> Se o painel já foi aberto antes, o admin já existe: use a aba “Minha conta” para trocar a senha.

## Entrar como barbeiro
- Pelo botão **Entrar** do próprio site, ou em `seu-dominio/admin`.
- Login inicial: `admin@barbeariadojota.com` / `admin123` → **troque a senha** na aba “Minha conta”.

## Domínio próprio (opcional)
Cloudflare → Workers & Pages → seu projeto → Settings → Domains & Routes → Add → Custom domain.

## Dados
Ficam no Durable Object (SQLite da Cloudflare), isolados e persistentes entre deploys.
Atualizar o site/preços de código = `npx wrangler deploy` de novo (os cadastros e agendamentos não são apagados).

## Observações
- O plano gratuito da Cloudflare comporta bem uma barbearia (Durable Objects SQLite estão no plano Free).
- Horários seguem o fuso de São Paulo (UTC-3), independentemente de onde o servidor esteja.
- Para mudar preços, contato, Instagram e horários: use o **painel** (não precisa mexer em código).
