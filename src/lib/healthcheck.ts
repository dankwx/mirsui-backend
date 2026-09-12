// Ping para o healthchecks.io — o "dead man's switch" dos crons.
//
// O monitor HTTP de fora (Better Stack) prova que o site responde; ele não
// prova que os jobs rodaram. Foi assim que os crons gravaram na nuvem por
// oito dias sem ninguém notar (docs/migracao-para-vps.md, §13, 11/09): o site
// estava 200 o tempo todo. Aqui a lógica é a inversa — o job avisa que
// terminou, e o silêncio é o alarme.
//
// Sem URL no .env não faz nada, de propósito: o dev local não deve acordar
// ninguém, e um job nunca pode falhar por causa do monitor que o vigia.
export async function pingHealthcheck(
  url: string | undefined,
  sufixo: '' | '/start' | '/fail' = ''
): Promise<void> {
  if (!url) return
  try {
    await fetch(url + sufixo, { method: 'POST', signal: AbortSignal.timeout(10_000) })
  } catch {
    // engolir é a intenção — ver o comentário acima
  }
}
