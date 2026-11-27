// Demand Manager — configuração opcional da sincronização (Supabase).
//
// Este arquivo traz a configuração do projeto Supabase deste app publicado (URL + chave PÚBLICA): todo aparelho
// que abrir o site já mostra "Entrar". Sem o bloco window.DM_CONFIG, o app funciona só em modo local.
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

window.DM_CONFIG = {
  supabaseUrl: 'https://cotzuocchywodlebmjen.supabase.co',
  supabaseKey: 'sb_publishable_5JNrtc7Xyqyi3l6vDvC0Vw_jilDtns0',
};
