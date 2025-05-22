const fs = require('fs').promises;
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');

// --- Helper Functions (copied/adapted from server.js) ---
function cleanOCRText(text) {
  const corrections = {
    'Açri': 'April',
    'Jaw': 'Jan',
    'Lending': 'Bending',
    'Â': '',
    'â': '',
    'ç': 'c'
  };
  let cleaned = text;
  for (const [wrong, right] of Object.entries(corrections)) {
    cleaned = cleaned.replace(new RegExp(wrong, 'g'), right);
  }
  return cleaned;
}

function parseLinesToQuestions(lines) {
  const questionRegex = /^(\d+)[\)\.]\s*/;
  const optionRegex = /^[a-d][\)\.]\s*/i;
  const answerSectionRegex = /MOCK BOARD EXAM ANSWERS|ANSWERS AND SOLUTIONS|ANSWERS:/i;
  const answerTableRegex = /^\d+\.\s*[A-E]/i;
  const asteriskAnswerRegex = /\*\s*$/;

  let inAnswerSection = false;
  let answers = {};
  let newQuestions = [];
  let errors = [];
  let i = 0;

  lines = lines.map(line => cleanOCRText(line.trim())).filter(line => line);

  while (i < lines.length) {
    let line = lines[i];

    if (answerSectionRegex.test(line)) {
      inAnswerSection = true;
      i++;
      continue;
    }

    if (inAnswerSection) {
      if (answerTableRegex.test(line)) {
        const match = line.match(/^(\d+)\.\s*([A-E])/i);
        if (match) {
          answers[match[1]] = match[2];
        }
      }
      i++;
      continue;
    }

    let questionMatch = line.match(questionRegex);
    if (questionMatch) {
      let questionNumber = questionMatch[1];
      let questionText = line.replace(questionRegex, '').trim();
      let questionLines = [questionText];
      i++;

      while (
        i < lines.length &&
        !optionRegex.test(lines[i]) &&
        !questionRegex.test(lines[i]) &&
        !answerSectionRegex.test(lines[i])
      ) {
        questionLines.push(lines[i].trim());
        i++;
      }

      let options = [];
      let inlineAnswer = null;
      let expectedOptions = 4;
      while (
        i < lines.length &&
        optionRegex.test(lines[i]) &&
        options.length < expectedOptions
      ) {
        let optionText = lines[i].replace(optionRegex, '').trim();
        let optionLines = [optionText];
        i++;
        while (
          i < lines.length &&
          !optionRegex.test(lines[i]) &&
          !questionRegex.test(lines[i]) &&
          !answerSectionRegex.test(lines[i]) &&
          lines[i].trim()
        ) {
          optionLines.push(lines[i].trim());
          i++;
        }
        let fullOptionText = optionLines.join(' ').trim();
        if (asteriskAnswerRegex.test(fullOptionText)) {
          inlineAnswer = String.fromCharCode(97 + options.length);
          fullOptionText = fullOptionText.replace(asteriskAnswerRegex, '').trim();
        }
        options.push(fullOptionText);
      }

      let question = {
        questionNumber,
        question: questionLines.join(' ').trim(),
        options,
        answer: inlineAnswer || ''
      };

      if (options.length < 2) {
        errors.push(`Question ${questionNumber}: Only ${options.length} options found, skipping`);
      } else if (options.length !== expectedOptions) {
        errors.push(`Question ${questionNumber}: Found ${options.length} options, expected ${expectedOptions}`);
      }

      newQuestions.push(question);
      continue;
    }

    i++;
  }

  newQuestions.forEach(q => {
    if (answers[q.questionNumber] && !q.answer) {
      const answerIndex = 'ABCD'.indexOf(answers[q.questionNumber].toUpperCase());
      if (answerIndex >= 0 && answerIndex < q.options.length) {
        q.answer = String.fromCharCode(97 + answerIndex);
      }
    }
  });

  const validQuestions = newQuestions.filter(q => q.options.length >= 2 && q.answer);
  errors.push(`Parsed ${newQuestions.length} questions, ${validQuestions.length} valid`);

  return { questions: validQuestions, errors };
}

async function parsePDF(filePath) {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    const text = data.text;
    return parseLinesToQuestions(text.split('\n'));
  } catch (error) {
    console.error('Error parsing PDF:', error.message);
    throw error;
  }
}

async function parseText(content) {
  return parseLinesToQuestions(content.split('\n'));
}

async function parseDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return parseText(result.value);
}
// --- End Helper Functions ---

const categorizedQuestionFile = 'cuestions.json';
const CATEGORIES = ['ELECTRONICS', 'ESAT', 'GEAS', 'MATHEMATICS'];

async function main() {
  const args = process.argv.slice(2);
  const categoryArg = args[0];
  const filePath = args[1];

  if (!categoryArg || !filePath) {
    console.log('Usage: node parse.js <category> <filepath>');
    console.log('Valid categories: electronics, esat, geas, mathematics');
    console.log('Example: node parse.js electronics questions.pdf');
    return;
  }

  const category = categoryArg.toUpperCase();
  if (!CATEGORIES.includes(category)) {
    console.error(`Invalid category: ${categoryArg}. Valid categories are: ${CATEGORIES.join(', ')}`);
    return;
  }

  let existingCategorizedQuestions = {
    ELECTRONICS: [],
    ESAT: [],
    GEAS: [],
    MATHEMATICS: []
  };

  try {
    const data = await fs.readFile(categorizedQuestionFile, 'utf8');
    const parsedData = JSON.parse(data);
    for (const cat of CATEGORIES) {
      if (parsedData[cat]) {
        existingCategorizedQuestions[cat] = parsedData[cat];
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') { // Ignore file not found error, it will be created
      console.error('Error loading existing categorized questions:', error.message);
      return;
    }
  }

  console.log(`Parsing file: ${filePath} for category: ${category}`);

  let result;
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === '.pdf') {
      result = await parsePDF(filePath);
    } else if (ext === '.txt') {
      const content = await fs.readFile(filePath, 'utf8');
      result = await parseText(content);
    } else if (ext === '.docx') {
      result = await parseDocx(filePath);
    } else {
      console.error('Unsupported file type. Only .pdf, .txt, and .docx are supported.');
      return;
    }
  } catch (parseError) {
    console.error('Error during file parsing:', parseError.message);
    return;
  }

  if (result.questions.length > 0) {
    existingCategorizedQuestions[category] = existingCategorizedQuestions[category].concat(result.questions);
    try {
      await fs.writeFile(categorizedQuestionFile, JSON.stringify(existingCategorizedQuestions, null, 2));
      console.log(`Successfully added ${result.questions.length} questions to ${category} category in ${categorizedQuestionFile}`);
      if (result.errors.length > 0) {
        console.warn('Parsing warnings/errors:');
        result.errors.forEach(err => console.warn(`- ${err}`));
      }
    } catch (writeError) {
      console.error('Error writing to categorized questions file:', writeError.message);
    }
  } else {
    console.log('No valid questions parsed from the file.');
    if (result.errors.length > 0) {
      console.warn('Parsing errors:');
      result.errors.forEach(err => console.warn(`- ${err}`));
    }
  }
}

main();