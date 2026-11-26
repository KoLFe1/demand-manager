// Demand Manager — configuração opcional da sincronização (Supabase).
//
// Este arquivo é um MODELO: do jeito que está, não define nada e o aplicativo funciona em modo local
// (os dados ficam só neste dispositivo).
//
// Há duas formas de ligar a sincronização entre dispositivos:
//
//   1) Pela tela  Configurações → Conta e sincronização  (recomendado): cole a URL do projeto e a chave
//      pública. Os valores ficam guardados só neste navegador e têm prioridade sobre este arquivo.
//
//   2) Por este arquivo (útil quando você hospeda o app e quer que todos os seus dispositivos já abram
//      configurados): apague o "//" das linhas abaixo e preencha com os dados do seu projeto Supabase
//      (Project Settings → API).
//
//      - supabaseUrl: a "Project URL", por exemplo https://abcdefghijkl.supabase.co
//      - supabaseKey: a chave PÚBLICA ("anon" / "publishable"). NUNCA use a chave "service_role" aqui:
//        este arquivo é entregue ao navegador de quem abrir o app.
//
// Antes do primeiro uso, execute o arquivo supabase/schema.sql inteiro no SQL Editor do Supabase
// (ele pode ser executado de novo depois de atualizações, sem perder dados).

// window.DM_CONFIG = {
//   supabaseUrl: 'https://SEU-PROJETO.supabase.co',
//   supabaseKey: 'SUA-CHAVE-PUBLICA',
// };
