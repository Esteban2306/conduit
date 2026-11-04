import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_DEFAULT_API_KEY!);

async function test() {
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
  });

  const result = await model.generateContent('Hola');
  console.log(result.response.text());
}

test();
