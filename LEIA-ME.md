# Asteroides (cofre offline) — teste no iPhone

## O que é
- Uma calculadora que funciona de verdade. Por trás dela há um cofre cifrado com AES-256-GCM, e a chave é derivada da sua frase com PBKDF2 (310 mil iterações).
- Depois de instalado, o app **não faz nenhuma conexão de rede**. A política de segurança (CSP `connect-src 'none'`) bloqueia qualquer requisição. Os textos ficam só no aparelho e sempre cifrados.

## Como abrir
- O app é um jogo de destruir asteroides, com fases, que funciona de verdade.
- Para abrir o cofre, toque em **👤 Jogador** e digite a senha como se fosse o seu nome. Isso também funciona na tela de "Fim de jogo".
- Se digitar qualquer outro nome, ele só aparece no botão, como num jogo normal.
- A senha de coação abre "Notas" com uma lista de compras falsa.
- Ao sair do app, o cofre trava sozinho.

## Primeiro uso
1. Com o cofre ainda vazio, digite **1234** como nome em "👤 Jogador" para abrir a tela "Criar cofre". Depois que o cofre existe, esse código deixa de funcionar.
2. Defina a frase-senha e, se quiser, uma frase de coação.

## Colocar a Bíblia
1. No Safari, abra ebible.org e busque **Bíblia Livre** (porbr2018). Em "Show formats for developers", baixe o arquivo **porbr2018_vpl.zip**.
2. No app Arquivos, toque no zip para extrair e mantenha o arquivo **porbr2018_vpl.txt**.
3. No cofre, vá em **Ajustes → Importar** e escolha esse .txt (título sugerido: BLIVRE). Os 66 livros entram separados, com navegação por capítulo e busca na Bíblia inteira.
4. Outros idiomas funcionam do mesmo jeito: basta baixar o arquivo `_vpl.zip` da tradução no eBible.org.
5. Depois, apague do app Arquivos o zip, a pasta extraída e o .txt.

## Instalar no iPhone (só a 1ª vez precisa de internet)
O iOS só deixa um app web funcionar offline se ele for aberto uma vez por HTTPS.
1. Publique a pasta num endereço HTTPS. Opções:
   - **GitHub Pages**: crie um repositório e envie estes arquivos (dá para fazer pelo site no celular). Depois ative em Settings → Pages.
   - **Netlify Drop** (pelo computador): arraste a pasta para app.netlify.com/drop.
2. No iPhone, abra o link **no Safari** e toque em Compartilhar → **Adicionar à Tela de Início**.
3. Abra o app pelo ícone uma vez, com internet, e espere 2–3 segundos.
4. Ative o **Modo Avião** e teste. Deve funcionar normalmente.
5. **Recomendado:** apague o site ou o repositório. O app continua funcionando pelo cache, e ninguém consegue enviar uma "atualização" para ele.

## Segurança
- Esta versão já vem sem o exemplo de teste.
- Use uma frase longa (4+ palavras) ou um código de 12+ dígitos.

## Limites honestos
- Um app web no iOS **não consegue bloquear capturas de tela**. Também não há garantia de que a miniatura do alternador de apps seja limpa a tempo, embora o app trave ao sair.
- Se você apagar o app da Tela de Início, ou limpar os dados do Safari, o cofre some. Guarde seus .txt em outro lugar.
- Ditado por voz: em iPhones recentes, vários idiomas são processados no próprio aparelho, mas a Apple pode usar servidores dependendo do idioma ou modelo. Para não depender disso, digite a frase.
- Para usar Argon2, Face ID ou bloqueio de print, o caminho é um app nativo (Swift/Xcode).
