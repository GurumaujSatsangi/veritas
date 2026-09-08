const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function extractFacts(pageText, pageNumber) {
  if (!pageText || pageText.trim() === '') return [];

  const tools = [
    {
      type: "function",
      function: {
        name: "extract_facts",
        description: "Extract factual claims from the given text.",
        parameters: {
          type: "object",
          properties: {
            facts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string", description: "The factual claim extracted from the text." },
                  subject: { type: "string", description: "The primary subject of the fact." },
                  value: { type: "number", description: "The numeric value associated with the fact, if applicable." },
                  unit: { type: "string", description: "The unit of measurement for the value, if applicable." },
                  time_scope: { type: "string", description: "The time frame or date associated with the fact, if applicable." },
                  span_start: { type: "integer", description: "The starting character index of the fact in the original text." },
                  span_end: { type: "integer", description: "The ending character index of the fact in the original text." }
                },
                required: ["text", "subject", "span_start", "span_end"],
                additionalProperties: false
              }
            }
          },
          required: ["facts"],
          additionalProperties: false
        }
      }
    }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: "You are an expert data extractor. Extract meaningful factual claims from the text. Do not assume a fixed schema for every fact. Some facts may have values/units/times, others may just be qualitative statements. Return an empty array if there are no facts (e.g. title pages). Do not invent facts." 
        },
        { 
          role: "user", 
          content: `Extract facts from the following text (Page ${pageNumber}):\n\n${pageText}` 
        }
      ],
      tools: tools,
      tool_choice: { type: "function", function: { name: "extract_facts" } }
    });

    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (toolCall && toolCall.function.name === 'extract_facts') {
      const args = JSON.parse(toolCall.function.arguments);
      return args.facts || [];
    }
    
    return [];
  } catch (error) {
    console.error(`Error extracting facts for page ${pageNumber}:`, error);
    return [];
  }
}

module.exports = { extractFacts };
