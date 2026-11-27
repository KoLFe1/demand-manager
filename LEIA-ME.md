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
   `Demand Manager: banco pronto (versão 3)`.
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

### Atualizar o banco para a v001 (versão 3 do banco)

A v001 do app precisa do banco na **versão 3** (tarefas recorrentes, data de cobrança e links). Rode
`supabase/schema.sql` **inteiro de novo** no SQL Editor (passo 2): nada é apagado e o resultado deve
mostrar `banco pronto (versão 3)`. Enquanto isso não for feito, o app avisa "Banco do servidor
desatualizado" e não sincroniza (os dados continuam salvos no aparelho).

## 3. Usar no celular

O app é uma página estática instalável (PWA). Para abrir no celular é preciso hospedá-lo num endereço
HTTPS: por exemplo GitHub Pages, Netlify ou Cloudflare Pages, publicando esta pasta como está (não há
etapa de build). Pastas `tests/`, `tools/`, `dev/` e `docs/` não são necessárias na hospedagem. Depois de
publicar, inclua o endereço em **Site URL / Redirect URLs** do Supabase (passo 3) e instale o app:
no Android/Chrome, menu → **Instalar app**; no iPhone (Safari), Compartilhar → **Adicionar à Tela de Início**.

**Captura rápida** (detalhes em Configurações → Captura rápida): com o app instalado no Android, use
**Compartilhar → Demand Manager** num e-mail, mensagem ou página; no iPhone, crie um **Atalho** (app
Atalhos) com "Abrir URL" e o endereço mostrado nas Configurações; no computador, arraste o favorito
**+ Demand Manager** para a barra de favoritos. Em todos os casos a "Nova tarefa" abre preenchida e você
confirma — nada é criado sozinho.

## 4. Novidades da v001

Na primeira abertura depois de atualizar, o app mostra as novidades uma vez (de novo em
Configurações → Sobre → **Ver novidades**).

- **Aguardando** (`G` então `A`): o que depende de outras pessoas, com data de cobrança e "Cobrei".
- **Cronograma** (`G` então `O`): Gantt de demandas e tarefas com dependências.
- **Relatório de status** (`G` então `R`): por período/projeto; imprimir/PDF, copiar ou enviar por e-mail.
- **Modelos de demanda**: Nova → "Demanda a partir de modelo…"; salve uma demanda como modelo pelo menu dela.
- **Links e arquivos** e **Repetir** (tarefas recorrentes) no painel da demanda/tarefa.
- **Resumo do dia**: no primeiro acesso do dia mostra atrasadas, vencimentos e cobranças (às segundas, a
  semana anterior); também no sino do Início e em `Ctrl+K` → "Resumo do dia". Liga/desliga em
  Configurações → Lembretes.
- **Exportar .ics**: no Calendário (ou Configurações → Calendário externo) gere o arquivo de prazos.
  - **Outlook** (computador): Arquivo → Abrir e Exportar → Importar/Exportar → "Importar um arquivo
    iCalendar (.ics)"; no Outlook web: Calendário → Adicionar calendário → Carregar do arquivo.
  - **Google Agenda** (computador): Configurações → Importar e exportar → Importar → escolha o arquivo e
    o calendário.
  - O arquivo é uma foto do momento: exporte de novo depois de mudar prazos (importar outra vez atualiza
    os eventos já importados, sem duplicar).

## 5. Atalhos principais

`Ctrl+K` busca e comandos · `Shift+N` nova demanda · `N` nova tarefa · `1`–`4` prioridade da linha
focada · `G` então `D/S/L/K/A/C/O/R…` muda de tela · `?` lista completa de atalhos.

## 6. Para quem for mexer no código

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
