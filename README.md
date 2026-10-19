# Dashboard de marcos de views (YouTube)

Todo dia o GitHub Actions lê os canais de `config.json`, salva os números em `docs/data.json`,
e o GitHub Pages publica o dashboard (`docs/index.html`) com:

- 🔥 **Quase lá**: vídeos a 90%+ da próxima meta, com barra de progresso, quanto falta e previsão de dias
- 🎉 **Bateram recentemente**: metas batidas nos últimos 14 dias, com caixinha "Post feito" (salva no seu navegador)
- Tabela de todos os vídeos com busca, filtro por canal e ordenação

## Configuração
1. Suba os arquivos para um repositório no GitHub.
2. **Chave da API**: console.cloud.google.com > criar projeto > ativar *YouTube Data API v3* > Credenciais > Chave de API.
3. No repositório: Settings > Secrets and variables > Actions > novo secret `YOUTUBE_API_KEY`.
4. Edite `config.json` com os canais (`@handle` ou ID `UC...`) e, se quiser, as metas.
5. Actions > "Atualizar dashboard" > Run workflow. (A 1ª execução só registra; metas já batidas antes não aparecem como "recentes".)
6. Settings > Pages > Source: *Deploy from a branch* > branch `main`, pasta `/docs`.

**Atenção:** no plano gratuito o GitHub Pages exige repositório **público** (os dados do YouTube já são públicos; a chave fica
nos Secrets e não aparece). Para manter privado, use Cloudflare Pages, Netlify ou Vercel apontando para a pasta `docs`.
