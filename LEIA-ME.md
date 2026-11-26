# Demand Manager

Gestão de demandas e tarefas pessoais: Projeto → Demanda → Tarefa → Subtarefa, prazos, dependências,
apontamento de horas, planejamento semanal ("Minha Semana"), Kanban, calendário, hierarquia, backlog e
métricas calculadas a partir do histórico. Funciona **sem internet e sem conta** (dados no navegador) e,
opcionalmente, **sincroniza entre dispositivos** pelo Supabase.

## 1. Abrir no computador

Requisito: Python 3 (já instalado nesta máquina). Não precisa de Node, npm nem instalação de pacotes.

- Dois cliques em **`Abrir Demand Manager.bat`**. O app abre em <http://127.0.0.1:8765/>.
  Mantenha a janela preta aberta enquanto usar.
- Ou, num terminal, a partir desta pasta:

  ```powershell
  python tools/devserver.py --open
  ```

Para conhecer o app com dados de exemplo (sem misturar com os seus), abra
<http://127.0.0.1:8765/?demo=1>. Esses dados ficam num banco separado e nunca são sincronizados.
Os dados de exemplo existem só na cópia local: não vão para o GitHub nem para o site publicado.

Sem Supabase, tudo fica guardado **só neste navegador** (IndexedDB). Para não perder nada, exporte um
backup de vez em quando em **Configurações → Dados → Exportar backup**.

## 2. Ligar a sincronização (Supabase)

1. Crie uma conta em <https://supabase.com> e um projeto novo (o plano gratuito basta).
2. No painel do projeto, abra **SQL Editor → New query**. Cole o arquivo
   [`supabase/schema.sql`](supabase/schema.sql) **inteiro** e clique em **Run**. O resultado deve mostrar
   `Demand Manager: banco pronto (versão 2)`.
   O editor pode avisar sobre operações "destrutivas" (`drop policy`/`drop trigger`): é esperado; nenhum
   dado é apagado. O script pode ser executado de novo depois de atualizações do app.
3. Em **Authentication → URL Configuration**, preencha **Site URL** com o endereço onde você abre o app
   (por exemplo `http://127.0.0.1:8765/` ou o endereço da hospedagem) e acrescente esse endereço em
   **Redirect URLs**. É para onde voltam os links de confirmação de e-mail e de "Esqueci minha senha".
4. Em **Project Settings → API**, copie a **Project URL** e a chave **pública** (`anon` / `publishable`).
   **Nunca** use a chave `service_role` no app.
5. No Demand Manager: **Configurações → Conta e sincronização**, cole a URL e a chave, clique em
   **Testar conexão** e depois em **Salvar**.
6. Clique em **Entrar** e crie sua conta (e-mail e senha). Se o projeto exigir confirmação de e-mail,
   confirme pelo link recebido.
7. Ao entrar pela primeira vez, o app pergunta se deve **trazer os dados deste dispositivo para a conta**.
   Responda "Trazer" no aparelho onde você já tem dados.

Repita os passos 5 e 6 em cada dispositivo (com a mesma conta). Alternativa: preencher `config.js`
(instruções dentro do arquivo) para que todos os dispositivos já abram configurados.

### Como a sincronização se comporta

- Tudo é gravado primeiro no aparelho; o envio acontece em segundo plano. Offline, o app continua
  funcionando e envia as alterações quando a conexão voltar (o indicador no rodapé da barra lateral
  mostra quantas estão pendentes).
- Se dois aparelhos alterarem o mesmo item, vale a alteração mais recente **de cada campo** (mudar o
  prazo num e a prioridade no outro preserva as duas).
- Trocar de conta exige recarregar a página: cada conta tem seu próprio banco local, e o app não envia
  nem recebe nada enquanto a conta conectada não for a dona dos dados abertos.
- "Banco do servidor desatualizado" significa que o app foi atualizado: execute `supabase/schema.sql`
  de novo (passo 2).

## 3. Usar no celular

O app é uma página estática instalável (PWA). Para abrir no celular é preciso hospedá-lo num endereço
HTTPS: por exemplo GitHub Pages, Netlify ou Cloudflare Pages, publicando esta pasta como está (não há
etapa de build). Pastas `tests/`, `tools/`, `dev/` e `docs/` não são necessárias na hospedagem. Depois de
publicar, inclua o endereço em **Site URL / Redirect URLs** do Supabase (passo 3) e, no celular, use
"Adicionar à tela inicial".

## 4. Atalhos principais

`Ctrl+K` busca e comandos · `Shift+N` nova demanda · `N` nova tarefa · `1`–`4` prioridade da linha
focada · `?` lista completa de atalhos.

## 5. Para quem for mexer no código

As pastas `tests/`, `tools/`, `dev/`, `docs/` e `js/dev/` ficam só na cópia local (estão no `.gitignore`):
o repositório público contém apenas o app que roda no site.

- `docs/ARQUITETURA.md`: módulos, contratos e decisões. `docs/ESPECIFICACAO.md`: pedido original.
- Testes (navegador headless, nenhuma janela abre):

  ```powershell
  python tools/run_tests.py
  ```

  `--suite e2e/semana` roda só um arquivo/pasta. SQL e sincronização são testados contra um Postgres
  real em WebAssembly (PGlite), baixado do CDN apenas durante os testes.
- Captura de tela headless: `python tools/shot.py --path "index.html?demo=1#/kanban" --out kanban.png`.
