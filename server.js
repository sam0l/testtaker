const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(fileUpload());
app.use(express.json()); // Added to parse JSON bodies
app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE'); // Ensure DELETE is allowed
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const uploadsDir = './uploads';
fs.mkdir(uploadsDir, { recursive: true })
  .then(() => console.log('Uploads directory ensured:', uploadsDir))
  .catch(err => console.error('Error ensuring uploads directory:', err));

let questions = [];
const questionFile = 'questions.json';

async function loadQuestions() {
  try {
    const data = await fs.readFile(questionFile, 'utf8');
    questions = JSON.parse(data);
    console.log('Loaded questions from', questionFile, ':', questions.length, 'questions');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('questions.json not found, starting with empty questions array.');
      questions = [];
    } else {
      console.error('Error loading questions:', error);
    }
  }
}

async function saveQuestions() {
  try {
    await fs.writeFile(questionFile, JSON.stringify(questions, null, 2), 'utf8');
    console.log('Questions saved to', questionFile);
  } catch (error) {
    console.error('Error saving questions:', error);
  }
}

// Helper to parse PDF content
async function parsePDF(filePath, uploadCategory) {
    console.log(`Parsing PDF: ${filePath} with upload category: ${uploadCategory}`);
    let errors = [];
    try {
        const dataBuffer = await fs.readFile(filePath);
        const data = await pdfParse(dataBuffer);
        const textContent = data.text;
        return parseText(textContent, uploadCategory); // Delegate to parseText for actual logic
    } catch (e) {
        console.error(`Error parsing PDF ${filePath}:`, e);
        errors.push(`Error parsing PDF: ${e.message}`);
    }
    return { questions: [], errors: errors };
}

// Helper to parse DOCX content
async function parseDocx(filePath, uploadCategory) {
    console.log(`Parsing DOCX: ${filePath} with upload category: ${uploadCategory}`);
    let errors = [];
    try {
        const { value, messages } = await mammoth.extractRawText({ path: filePath });
        if (messages) {
            messages.forEach(msg => errors.push(`DOCX parsing warning/error: ${msg.message}`));
        }
        return parseText(value, uploadCategory); // Delegate to parseText for actual logic
    } catch (e) {
        console.error(`Error parsing DOCX ${filePath}:`, e);
        errors.push(`Error parsing DOCX: ${e.message}`);
    }
    return { questions: [], errors: errors };
}

// Centralized parsing logic for text content (from PDF, DOCX, or TXT)
async function parseText(text, uploadCategory) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const newQuestions = [];
    const errors = [];
    let currentQuestion = null;
    let inOptionsPhase = false; // Flag to indicate we are currently parsing options for the current question
    let detectedCategory = uploadCategory || "UNCATEGORIZED"; // Use uploadCategory as primary, fallback to UNCATEGORIZED

    // Attempt to extract category from the first few lines of the document
    for (let i = 0; i < Math.min(lines.length, 10); i++) { // Check first 10 lines
        const categoryMatch = lines[i].match(/MOCK BOARD EXAMINATION IN\s*([A-Z\s]+)/i);
        if (categoryMatch && categoryMatch[1]) {
            detectedCategory = categoryMatch[1].trim().replace(/\(.*\)/g, '').trim().toUpperCase(); // Remove parentheses and convert to uppercase
            console.log(`[Parser] Detected category from document: ${detectedCategory}`);
            break;
        }
    }

    // Regex for answer section headers (to skip or extract answers from)
    const answerSectionHeaderRegex = /MOCK BOARD EXAM ANSWERS|ANSWERS AND SOLUTIONS|ANSWERS:|SOLUTION(?:S)?:/i;
    // Relaxed Regex for individual answers in an answer section (e.g., "1. B", "45. A", "1 A")
    const answerLineRegex = /^(\d+)\s*[.)]?\s*([A-Ea-e])/;
    let answersFromSection = {}; // To store answers from a dedicated section

    let inAnswerSection = false;

    for (const line of lines) {
        // Check if we are entering an answer section
        if (answerSectionHeaderRegex.test(line)) {
            inAnswerSection = true;
            console.log(`[Parser] Entering answer section.`);
            continue; // Skip the header line itself
        }

        // If in answer section, parse answers
        if (inAnswerSection) {
            const answerMatch = line.match(answerLineRegex);
            if (answerMatch) {
                const qNum = parseInt(answerMatch[1], 10);
                const ansLetter = answerMatch[2].toUpperCase();
                answersFromSection[qNum] = ansLetter;
                // console.log(`[Parser] Parsed answer from section: Q${qNum} -> ${ansLetter}`);
            }
            // Do not `continue` here, as an answer section might be followed by more questions
            // or other content that needs to be parsed. The `inAnswerSection` flag will
            // ensure lines matching `answerLineRegex` are processed, but other lines won't
            // be skipped if they don't match.
        }


        // New question pattern (e.g., "1) What is...", "1. What is...")
        const questionMatch = line.match(/^(\d+)[).]\s*(.*)/);
        if (questionMatch) {
            if (currentQuestion) {
                // Before pushing the old question, ensure it's complete
                if (currentQuestion.question && currentQuestion.options.length >= 2 && currentQuestion.correctAnswer !== undefined) {
                    newQuestions.push(currentQuestion);
                } else {
                    errors.push(`Incomplete question (Q${currentQuestion.questionNumber || 'N/A'}): "${currentQuestion.question}" - missing options or answer.`);
                }
            }
            currentQuestion = {
                questionNumber: questionMatch[1],
                question: questionMatch[2].trim(),
                options: [],
                correctAnswer: undefined, // Will be set from answer section or inline
                category: detectedCategory // Assign detected category
            };
            inOptionsPhase = true; // Assume next lines are options
        } else if (currentQuestion) {
            // Option pattern (e.g., "a) Option text", "A. Option text", "a. Option text")
            const optionMatch = line.match(/^[a-dA-D][).]\s*(.*)/);
            if (optionMatch) {
                const optionText = optionMatch[1].trim();
                currentQuestion.options.push(optionText);
                inOptionsPhase = true; // Confirm we are in options phase

                // Handle inline answers with '*'
                if (optionText.endsWith('*')) {
                    const cleanOptionText = optionText.slice(0, -1).trim();
                    currentQuestion.options[currentQuestion.options.length - 1] = cleanOptionText; // Clean the option text
                    currentQuestion.correctAnswer = currentQuestion.options.length - 1; // Set correct answer
                    console.log(`[Parser] Inline answer detected for Q${currentQuestion.questionNumber}: Option ${String.fromCharCode(65 + currentQuestion.correctAnswer)}`);
                }
            } else if (line.toLowerCase().startsWith('answer:') || line.toLowerCase().startsWith('ans:')) {
                const answerMatch = line.match(/(?:answer|ans):\s*([a-dA-D])/i);
                if (answerMatch) {
                    currentQuestion.correctAnswer = answerMatch[1].toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0);
                    inOptionsPhase = false; // Assume options are done after inline answer
                    console.log(`[Parser] Inline 'Answer:' found for Q${currentQuestion.questionNumber}: Option ${String.fromCharCode(65 + currentQuestion.correctAnswer)}`);
                }
            } else if (inOptionsPhase && currentQuestion.options.length > 0) {
                // If we are in options phase and have existing options, append this line to the last option
                currentQuestion.options[currentQuestion.options.length - 1] += ' ' + line;
            } else {
                // If not an option, and not in options phase, but we have a current question, assume it's more question text
                currentQuestion.question += ' ' + line;
            }
        }
    }

    // Add the last question if it exists and is complete
    if (currentQuestion) {
        if (currentQuestion.question && currentQuestion.options.length >= 2 && currentQuestion.correctAnswer !== undefined) {
            newQuestions.push(currentQuestion);
        } else {
            errors.push(`Incomplete question (Q${currentQuestion.questionNumber || 'N/A'}): "${currentQuestion.question}" - missing options or answer (last question).`);
        }
    }

    // Post-processing: Assign correct answers from the answer section (overwrites inline if found, but inline is prioritized if found first)
    newQuestions.forEach(q => {
        if (answersFromSection[q.questionNumber] && q.correctAnswer === undefined) { // Only assign if not already set by inline '*' or 'Answer:'
            const answerLetter = answersFromSection[q.questionNumber];
            const answerIndex = 'ABCD'.indexOf(answerLetter); // Convert A, B, C, D to 0, 1, 2, 3
            if (answerIndex !== -1 && answerIndex < q.options.length) {
                q.correctAnswer = answerIndex;
                // console.log(`[Parser] Assigned correct answer for Q${q.questionNumber} from section: ${answerLetter} (index ${answerIndex})`);
            } else {
                errors.push(`Answer for Q${q.questionNumber} (${answerLetter}) from section not found in options or invalid index.`);
            }
        } else if (q.correctAnswer === undefined) {
            errors.push(`No answer found for Q${q.questionNumber} in document or section.`);
        }
    });

    console.log(`[Parser] Final parsed questions count: ${newQuestions.length}`);
    return { questions: newQuestions, errors: errors };
}