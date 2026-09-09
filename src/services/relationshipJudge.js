const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function judgeRelationship(factA, factB) {
  const prompt = `You are an expert fact-checker and logical relationship analyzer.
Analyze the relationship between the following two facts.
Classify their relationship into one of the following types:
- "corroborates": Both facts support or present the same underlying claim.
- "contradicts": The facts present conflicting claims that cannot both be true.
- "reconciled": The facts appear to conflict, but the difference is naturally explained by differing units, time periods, or scope.
- "unrelated": The facts discuss fundamentally different topics with no logical connection.

CRITICAL INSTRUCTION: Before classifying as "contradicts", you must explicitly check for differences in units, time periods (time scope), and subject scope. If a difference is explained by those factors, you MUST classify it as "reconciled" and explain why in exactly one sentence.

Fact A:
Text: ${factA.text || 'N/A'}
Subject: ${factA.subject || 'N/A'}
Value: ${factA.value !== undefined && factA.value !== null ? factA.value : 'N/A'}
Unit: ${factA.unit || 'N/A'}
Time Scope: ${factA.time_scope || 'N/A'}

Fact B:
Text: ${factB.text || 'N/A'}
Subject: ${factB.subject || 'N/A'}
Value: ${factB.value !== undefined && factB.value !== null ? factB.value : 'N/A'}
Unit: ${factB.unit || 'N/A'}
Time Scope: ${factB.time_scope || 'N/A'}
`;

  const tools = [
    {
      type: "function",
      function: {
        name: "output_relationship",
        description: "Output the classification of the relationship between two facts.",
        parameters: {
          type: "object",
          properties: {
            type: { 
              type: "string", 
              enum: ["corroborates", "contradicts", "reconciled", "unrelated"],
              description: "The classified relationship type."
            },
            explanation: { 
              type: "string", 
              description: "A one sentence explanation of why this classification was chosen. If reconciled, explain the specific factors (unit, time scope, etc.) that account for the difference." 
            },
            confidence: { 
              type: "number", 
              description: "Your confidence level in this classification, represented as a float from 0.0 to 1.0." 
            }
          },
          required: ["type", "explanation", "confidence"],
          additionalProperties: false
        }
      }
    }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: process.env.JUDGE_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an expert logical relationship analyzer." },
        { role: "user", content: prompt }
      ],
      tools: tools,
      tool_choice: { type: "function", function: { name: "output_relationship" } },
      temperature: 0.1
    });

    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (toolCall && toolCall.function.name === 'output_relationship') {
      const result = JSON.parse(toolCall.function.arguments);
      return result;
    }
    
    return { type: "unrelated", explanation: "Unexpected response format from model.", confidence: 0 };
  } catch (error) {
    console.error("Error judging relationship between facts:", error);
    return { type: "unrelated", explanation: `Analysis failed: ${error.message}`, confidence: 0 };
  }
}

module.exports = { judgeRelationship };
