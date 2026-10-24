#!/usr/bin/env node
'use strict';
 
/**
 * Extrator de dados de nota fiscal de serviço (PDF).
 *
 * INSTALAÇÃO (Node.js 18+):
 *   npm init -y
 *   npm install pdf-parse@1.1.1
 *   # Necessário para ler a OS (foto/PDF escaneado) via OCR:
 *   npm install tesseract.js pdf-to-img
 *
 * USO:
 *   node index.js                          (analisa os PDFs da mesma pasta do index.js:
 *                                           nota fiscal, boleto e OS)
 *   node index.js nota.pdf boleto.pdf os.pdf   (arquivos específicos)
 */
 
const fs = require('fs');
const path = require('path');
 
const NAO_ENCONTRADO = 'Não encontrado';
 
/* ------------------------------------------------------------------ */
/* Utilitários                                                         */
/* ------------------------------------------------------------------ */
 
/** Valida os dígitos verificadores de um CNPJ. */
function validarCnpj(cnpj) {
  const d = cnpj.replace(/\D/g, '');
  // Precisa ter 14 dígitos e não pode ser sequência repetida (ex.: 000...0)
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
 
  const calcularDigito = (base) => {
    const pesos =
      base.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = base
      .split('')
      .reduce((acc, n, i) => acc + Number(n) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
 
  const d1 = calcularDigito(d.slice(0, 12));
  const d2 = calcularDigito(d.slice(0, 12) + d1);
  return d1 === Number(d[12]) && d2 === Number(d[13]);
}
 
/** Formata 14 dígitos como 00.000.000/0000-00. */
function formatarCnpj(cnpj) {
  return cnpj
    .replace(/\D/g, '')
    .replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}
 
/** Converte "1.234,56" em 1234.56. */
function paraNumero(valorBr) {
  return Number(valorBr.replace(/\./g, '').replace(',', '.'));
}
 
/** Formata número como "R$ 1.234,56". */
function formatarMoeda(numero) {
  return numero
    .toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    .replace(/\u00a0/g, ' ');
}
 
/** Posição da última ocorrência de uma regex (com flag g) em um texto. */
function ultimaPosicao(regex, texto) {
  let pos = -1;
  for (const m of texto.matchAll(regex)) pos = m.index;
  return pos;
}
 
/* ------------------------------------------------------------------ */
/* Leitura do PDF                                                      */
/* ------------------------------------------------------------------ */
 
/** Extrai o texto de um PDF com camada de texto. */
async function extrairTextoPdf(buffer) {
  // Importa direto do arquivo da lib para evitar o modo debug do pdf-parse
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const resultado = await pdfParse(buffer);
  return resultado.text || '';
}
 
/** Fallback: OCR para PDFs escaneados (requer tesseract.js e pdf-to-img). */
async function extrairTextoComOcr(caminho) {
  let pdfParaImagens;
  let Tesseract;
  try {
    ({ pdf: pdfParaImagens } = await import('pdf-to-img'));
    Tesseract = require('tesseract.js');
  } catch {
    throw new Error(
      'O PDF parece escaneado e o OCR não está instalado. ' +
        'Rode: npm install tesseract.js pdf-to-img'
    );
  }
 
  const worker = await Tesseract.createWorker('por');
  try {
    let texto = '';
    const paginas = await pdfParaImagens(caminho, { scale: 2 });
    for await (const imagem of paginas) {
      const { data } = await worker.recognize(imagem);
      texto += data.text + '\n';
    }
    return texto;
  } finally {
    await worker.terminate();
  }
}
 
/* ------------------------------------------------------------------ */
/* Extração dos campos                                                 */
/* ------------------------------------------------------------------ */
 
// Rótulos que indicam a qual empresa pertence um CNPJ.
// Prestador = quem presta o serviço; Tomador = quem contrata (emissor do chamado).
const ROTULOS_PRESTADOR = /prestador|emitente|fornecedor/gi;
const ROTULOS_TOMADOR = /tomador|contratante|cliente|destinat[aá]rio/gi;
 
/**
 * Localiza todos os CNPJs válidos e tenta classificá-los em
 * prestador / tomador pelo rótulo mais próximo antes de cada um.
 */
function extrairCnpjs(texto) {
  const avisos = [];
  const todos = [];
 
  // 00.000.000/0000-00 ou 14 dígitos corridos; (?<!\d) e (?!\d) evitam
  // pegar pedaços de números maiores (ex.: chave de acesso de 44 dígitos)
  const regexCnpj = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;
 
  let fimAnterior = 0;
  for (const m of texto.matchAll(regexCnpj)) {
    if (!validarCnpj(m[0])) continue;
    const cnpj = formatarCnpj(m[0]);
 
    // Janela de até 250 caracteres antes do CNPJ, sem passar do CNPJ anterior
    const inicio = Math.max(fimAnterior, m.index - 250);
    const janela = texto.slice(inicio, m.index);
    const posPrestador = ultimaPosicao(ROTULOS_PRESTADOR, janela);
    const posTomador = ultimaPosicao(ROTULOS_TOMADOR, janela);
 
    let papel = null;
    if (posPrestador > posTomador) papel = 'prestador';
    else if (posTomador > posPrestador) papel = 'tomador';
 
    // Ignora CNPJs repetidos (o mesmo CNPJ pode aparecer várias vezes)
    if (!todos.some((c) => c.cnpj === cnpj)) todos.push({ cnpj, papel });
    fimAnterior = m.index + m[0].length;
  }
 
  let prestador = todos.find((c) => c.papel === 'prestador')?.cnpj ?? null;
  let tomador = todos.find((c) => c.papel === 'tomador')?.cnpj ?? null;
 
  // Se só um foi identificado e há exatamente dois CNPJs, o outro é o restante
  if (todos.length === 2 && (!prestador || !tomador) && (prestador || tomador)) {
    const outro = todos.find((c) => c.cnpj !== (prestador || tomador)).cnpj;
    if (!prestador) prestador = outro;
    else tomador = outro;
    avisos.push('Um dos CNPJs foi deduzido por exclusão. Confira o resultado.');
  }
 
  if (!prestador && !tomador && todos.length > 0) {
    avisos.push(
      'Não foi possível diferenciar prestador e tomador. CNPJs encontrados: ' +
        todos.map((c) => c.cnpj).join(', ')
    );
  }
 
  return { prestador, tomador, avisos };
}
 
/**
 * Procura um valor monetário logo depois de um dos rótulos, em ordem
 * de prioridade (do mais específico ao mais genérico).
 */
function buscarValor(texto, rotulos) {
  for (const rotulo of rotulos) {
    // rótulo + até 60 caracteres não numéricos + (R$) + número no padrão 1.234,56
    const regex = new RegExp(
      `${rotulo}[^\\d]{0,60}?(?:R\\$\\s*)?(\\d{1,3}(?:\\.\\d{3})*,\\d{2})`,
      'i'
    );
    const m = texto.match(regex);
    if (m) return paraNumero(m[1]);
  }
  return null;
}
 
function extrairValorBruto(texto) {
  return buscarValor(texto, [
    'valor\\s+bruto',
    'valor\\s+total\\s+dos\\s+servi[cç]os',
    'valor\\s+dos\\s+servi[cç]os',
    'valor\\s+total\\s+da\\s+nota',
    'valor\\s+total',
  ]);
}
 
function extrairValorLiquido(texto) {
  // "Valor Líquido", "Valor Líquido da Nota", "Valor Líquido da NFS-e"
  return buscarValor(texto, ['valor\\s+l[ií]quido']);
}
 
function extrairDescricao(texto) {
  // Rótulos que iniciam a descrição
  const inicio =
    '(?:discrimina[cç][aã]o\\s+(?:dos\\s+)?servi[cç]os?|descri[cç][aã]o\\s+(?:dos?\\s+)?servi[cç]os?|discrimina[cç][aã]o)';
  // Início de linha que marca o próximo campo/seção (fim da descrição)
  const fim =
    '(?:valor|base\\s+de\\s+c[aá]lculo|dedu[cç][õo]es|c[oó]digo\\s+d[oa]|tributa|iss|reten[cç]|outras\\s+informa|informa[cç][õo]es\\s+complementares|pis|cofins|inss|irrf|csll)';
 
  const regex = new RegExp(
    `${inicio}\\s*:?\\s*([\\s\\S]+?)(?=\\n\\s*${fim}|$)`,
    'i'
  );
  const m = texto.match(regex);
  if (!m) return null;
 
  const descricao = m[1].replace(/\s+/g, ' ').trim();
  if (!descricao) return null;
  return descricao.length > 1000 ? descricao.slice(0, 1000) + '…' : descricao;
}
 
/**
 * Procura o número da nota depois de rótulos como "Número da Nota",
 * "Número da NFS-e" ou "Nota Fiscal nº". Aceita formatos como 12345
 * ou 2026/123 (ano/número).
 */
function extrairNumeroNota(texto) {
  const rotulos = [
    'n[úu]mero\\s+da\\s+nota(?:\\s+fiscal)?',
    'n[úu]mero\\s+da\\s+nfs-?e',
    'nfs-?e\\s*(?:n[º°o.]|n[úu]mero)',
    'nota\\s+fiscal(?:\\s+de\\s+servi[cç]os?)?(?:\\s+eletr[ôo]nica)?\\s*(?:n[º°o.]|n[úu]mero)',
  ];
 
  for (const rotulo of rotulos) {
    // rótulo + até 30 caracteres não numéricos + número (com / . - opcional no meio)
    const regex = new RegExp(`${rotulo}[^\\d]{0,30}?(\\d{1,15}(?:[./-]\\d{1,10})?)`, 'i');
    const m = texto.match(regex);
    if (m) return m[1];
  }
  return null;
}
 
/**
 * Procura uma data no formato dd/mm/aaaa (também aceita - ou . como
 * separador) logo depois de um dos rótulos, testados em ordem.
 * Se houver hora junto (ex.: 24/10/2026 14:30), só a data é retornada.
 */
function buscarData(texto, rotulos) {
  for (const rotulo of rotulos) {
    // rótulo + até 40 caracteres não numéricos + data dd/mm/aaaa
    const regex = new RegExp(
      `${rotulo}[^\\d]{0,40}?(\\d{2}[/.-]\\d{2}[/.-]\\d{4})`,
      'i'
    );
    const m = texto.match(regex);
    if (m) return m[1].replace(/[.-]/g, '/');
  }
  return null;
}
 
function extrairDataEmissao(texto) {
  // "Data de Emissão", "Data e Hora de Emissão", "Emitida em", "Emissão"
  return buscarData(texto, [
    'data\\s+(?:e\\s+hora\\s+)?(?:de\\s+)?emiss[ãa]o',
    'emitid[ao]\\s+em',
    'emiss[ãa]o',
  ]);
}
 
function extrairDataVencimento(texto) {
  // "Data de Vencimento", "Vencimento", "Vence em"
  return buscarData(texto, [
    'data\\s+(?:de\\s+)?vencimento',
    'vence\\s+em',
    'vencimento',
  ]);
}
 
/* ------------------------------------------------------------------ */
/* Programa principal                                                  */
/* ------------------------------------------------------------------ */
 
/** Nomes amigáveis de cada tipo de documento. */
const NOMES_TIPO = {
  nota: 'Nota fiscal',
  boleto: 'Boleto',
  os: 'OS (ordem de serviço)',
};
 
// Palavras e padrões que denunciam o tipo de cada documento.
// Cada padrão encontrado soma um ponto para aquele tipo.
const PADROES_TIPO = {
  boleto: [
    /linha\s+digit[aá]vel/i,
    /nosso\s+n[úu]mero/i,
    /benefici[aá]rio/i,
    /pagador|sacado/i,
    /ficha\s+de\s+compensa[cç][aã]o/i,
    // sequência típica da linha digitável: 00000.00000 00000.000000 ...
    /\d{5}\.\d{5}\s+\d{5}\.\d{6}\s+\d{5}\.\d{6}/,
  ],
  nota: [
    /nota\s+fiscal/i,
    /nfs-?e/i,
    /prestador/i,
    /tomador/i,
    /discrimina[cç][aã]o\s+d/i,
    /c[oó]digo\s+de\s+verifica[cç][aã]o/i,
  ],
  os: [
    /ordem\s+de\s+servi[cç]o/i,
    /(?:^|[^a-z])O\.?\s?S\.?\s*(?:n[º°o.]|:|\d)/i,
    /servi[cç]os?\s+(?:executados?|realizados?)/i,
    /t[eé]cnico/i,
    /assinatura/i,
  ],
};
 
/**
 * Descobre se o PDF é nota, boleto ou OS. Soma pontos pelo conteúdo e
 * por dicas no nome do arquivo. Retorna 'nota', 'boleto', 'os' ou null.
 */
function classificarDocumento(nomeArquivo, texto, escaneado) {
  const pontos = { nota: 0, boleto: 0, os: 0 };
 
  for (const [tipo, padroes] of Object.entries(PADROES_TIPO)) {
    for (const padrao of padroes) {
      if (padrao.test(texto)) pontos[tipo]++;
    }
  }
 
  // Dicas pelo nome do arquivo (ex.: "boleto_123.pdf", "OS 45.pdf")
  const nome = nomeArquivo.toLowerCase();
  if (/boleto/.test(nome)) pontos.boleto += 2;
  if (/nota|(?:^|[^a-z])nfs?e?(?:[^a-z]|$)/.test(nome)) pontos.nota += 2;
  if (/ordem|(?:^|[^a-z])os(?:[^a-z]|$)/.test(nome)) pontos.os += 2;
 
  // Nota e boleto costumam ser PDFs digitais; a foto da folha tende a ser a OS
  if (escaneado) pontos.os += 1;
 
  let melhor = null;
  let maior = 0;
  for (const [tipo, p] of Object.entries(pontos)) {
    if (p > maior) {
      melhor = tipo;
      maior = p;
    }
  }
  return melhor;
}
 
/**
 * Descrição do serviço na OS. Procura rótulos como "Serviço executado"
 * ou "Descrição do serviço" e captura até o próximo campo da folha.
 */
function extrairDescricaoOS(texto) {
  // Rótulos que iniciam a descrição (do mais específico ao mais genérico)
  const inicio =
    '(?:servi[cç]os?\\s+(?:executados?|realizados?|prestados?)|descri[cç][aã]o\\s+(?:d[oa]s?\\s+)?(?:servi[cç]os?|trabalhos?|atividades?)|atividades?\\s+realizadas?|descri[cç][aã]o)';
  // Campos comuns de uma OS que encerram a descrição (no início de uma linha)
  const fim =
    '(?:assinatura|data|cliente|t[eé]cnico|respons[aá]vel|valor|materiais?|pe[cç]as|observa[cç]|hor[aá]rio|in[ií]cio|t[eé]rmino|garantia)';
 
  const regex = new RegExp(
    `${inicio}\\s*:?\\s*([\\s\\S]+?)(?=\\n\\s*${fim}|$)`,
    'i'
  );
  const m = texto.match(regex);
  if (!m) return null;
 
  const descricao = resumirTexto(m[1]);
  return descricao || null;
}
 
/** Junta quebras de linha/espaços e limita o tamanho do texto. */
function resumirTexto(texto) {
  const t = texto.replace(/\s+/g, ' ').trim();
  return t.length > 1000 ? t.slice(0, 1000) + '…' : t;
}
 
/**
 * Lê o texto de um PDF. Se não houver texto selecionável (foto/scan),
 * usa OCR. Retorna o texto e se foi necessário usar OCR.
 */
async function lerTexto(caminho) {
  let texto = '';
  try {
    texto = await extrairTextoPdf(fs.readFileSync(caminho));
  } catch (erro) {
    throw new Error(`não foi possível ler o PDF (corrompido?): ${erro.message}`);
  }
 
  if (texto.trim().length >= 50) return { texto, escaneado: false };
 
  console.warn(
    `Aviso: "${path.basename(caminho)}" parece ser uma imagem. Usando OCR (pode demorar)...`
  );
  return { texto: await extrairTextoComOcr(caminho), escaneado: true };
}
 
async function main() {
  // Arquivos informados manualmente ou, se nenhum, todos os PDFs da pasta do script
  const argumentos = process.argv.slice(2);
  let arquivos;
 
  if (argumentos.length > 0) {
    arquivos = argumentos.map((a) => path.resolve(a));
  } else {
    // __dirname = pasta onde o index.js está salvo
    arquivos = fs
      .readdirSync(__dirname)
      .filter((nome) => nome.toLowerCase().endsWith('.pdf'))
      .map((nome) => path.join(__dirname, nome));
 
    if (arquivos.length === 0) {
      console.error(`Nenhum PDF encontrado na pasta: ${__dirname}`);
      process.exit(1);
    }
  }
 
  // Lê e classifica cada PDF: nota, boleto ou OS
  const docs = { nota: null, boleto: null, os: null };
  const avisos = [];
 
  for (const arquivo of arquivos) {
    const nome = path.basename(arquivo);
 
    if (!fs.existsSync(arquivo)) {
      avisos.push(`Arquivo não encontrado: ${nome}`);
      continue;
    }
 
    try {
      const { texto, escaneado } = await lerTexto(arquivo);
      const tipo = classificarDocumento(nome, texto, escaneado);
 
      if (!tipo) {
        avisos.push(`Não consegui identificar o tipo de "${nome}" (nota, boleto ou OS).`);
      } else if (docs[tipo]) {
        avisos.push(
          `Há mais de um arquivo do tipo ${NOMES_TIPO[tipo]} ("${docs[tipo].nome}" e "${nome}"). Usando o primeiro.`
        );
      } else {
        docs[tipo] = { nome, texto };
      }
    } catch (erro) {
      avisos.push(`"${nome}": ${erro.message}`);
    }
  }
 
  for (const tipo of Object.keys(docs)) {
    if (!docs[tipo]) avisos.push(`Não encontrei o arquivo do tipo: ${NOMES_TIPO[tipo]}.`);
  }
 
  // Campos da nota fiscal
  const textoNota = docs.nota?.texto ?? '';
  const numeroNota = extrairNumeroNota(textoNota);
  const dataEmissao = extrairDataEmissao(textoNota);
  const { prestador, tomador, avisos: avisosCnpj } = extrairCnpjs(textoNota);
  const bruto = extrairValorBruto(textoNota);
  const liquido = extrairValorLiquido(textoNota);
  avisos.push(...avisosCnpj);
 
  // Vencimento: vem do boleto; se não achar, tenta na nota
  const dataVencimento =
    (docs.boleto && extrairDataVencimento(docs.boleto.texto)) ||
    extrairDataVencimento(textoNota);
 
  // Descrição: vem da OS; se não achar, tenta na nota
  let descricao = null;
  if (docs.os) {
    descricao = extrairDescricaoOS(docs.os.texto);
    if (!descricao) {
      // A folha pode não ter rótulos legíveis: mostra o texto lido para conferência
      descricao = resumirTexto(docs.os.texto) || null;
      if (descricao) {
        avisos.push(
          'Não encontrei o campo de descrição na OS; mostrando o texto lido da folha. Confira.'
        );
      }
    }
  }
  if (!descricao) descricao = extrairDescricao(textoNota);
 
  // Saída
  console.log('\nArquivos identificados:');
  for (const [tipo, doc] of Object.entries(docs)) {
    console.log(`  ${NOMES_TIPO[tipo]}: ${doc ? doc.nome : NAO_ENCONTRADO}`);
  }
 
  console.log('');
  console.log(`Número da nota: ${numeroNota ?? NAO_ENCONTRADO}`);
  console.log(`Data de emissão: ${dataEmissao ?? NAO_ENCONTRADO}`);
  console.log(`Data de vencimento: ${dataVencimento ?? NAO_ENCONTRADO}`);
  console.log(`CNPJ do emissor do chamado: ${tomador ?? NAO_ENCONTRADO}`);
  console.log(`CNPJ do prestador do serviço: ${prestador ?? NAO_ENCONTRADO}`);
  console.log(
    `Valor bruto: ${bruto !== null ? formatarMoeda(bruto) : NAO_ENCONTRADO}`
  );
  console.log(
    `Valor líquido: ${liquido !== null ? formatarMoeda(liquido) : NAO_ENCONTRADO}`
  );
  console.log(`Descrição do serviço: ${descricao ?? NAO_ENCONTRADO}`);
 
  for (const aviso of avisos) console.warn(`\nAviso: ${aviso}`);
}
 
main().catch((erro) => {
  console.error(`Erro inesperado: ${erro.message}`);
  process.exit(1);
});