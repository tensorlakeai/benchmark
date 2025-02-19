import { GoogleGenerativeAI } from '@google/generative-ai';

import { ModelProvider } from './base';
import {
  IMAGE_EXTRACTION_SYSTEM_PROMPT,
  JSON_EXTRACTION_SYSTEM_PROMPT,
  OCR_SYSTEM_PROMPT,
} from './shared/prompt';
import { calculateTokenCost } from './shared/tokenCost';
import { getMimeType } from '../utils';
import { JsonSchema } from '../types';

export class GeminiProvider extends ModelProvider {
  private client: GoogleGenerativeAI;

  constructor(model: string) {
    super(model);

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    if (!apiKey) {
      throw new Error('Missing required Google Generative AI configuration');
    }

    this.client = new GoogleGenerativeAI(apiKey);
  }

  async ocr(imagePath: string) {
    try {
      const start = performance.now();

      const model = this.client.getGenerativeModel({
        model: this.model,
        generationConfig: { temperature: 0 },
      });

      // read image and convert to base64
      const response = await fetch(imagePath);
      const imageBuffer = await response.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString('base64');

      const imagePart = {
        inlineData: {
          data: base64Image,
          mimeType: getMimeType(imagePath),
        },
      };

      const ocrResult = await model.generateContent([OCR_SYSTEM_PROMPT, imagePart]);
      const text = ocrResult.response.text();

      const end = performance.now();

      const ocrInputTokens = ocrResult.response.usageMetadata.promptTokenCount;
      const ocrOutputTokens = ocrResult.response.usageMetadata.candidatesTokenCount;
      const inputCost = calculateTokenCost(this.model, 'input', ocrInputTokens);
      const outputCost = calculateTokenCost(this.model, 'output', ocrOutputTokens);

      return {
        text,
        usage: {
          duration: end - start,
          inputTokens: ocrInputTokens,
          outputTokens: ocrOutputTokens,
          totalTokens: ocrInputTokens + ocrOutputTokens,
          inputCost,
          outputCost,
          totalCost: inputCost + outputCost,
        },
      };
    } catch (error) {
      console.error('Google Generative AI OCR Error:', error);
      throw error;
    }
  }

  // FIXME: JSON output might not be 100% correct yet, because Gemini uses a subset of OpenAPI 3.0 schema
  // https://sdk.vercel.ai/providers/ai-sdk-providers/google-generative-ai#schema-limitations
  async extractFromText(text: string, schema: JsonSchema) {
    const filteredSchema = this.convertSchemaForGemini(schema);

    const start = performance.now();
    const model = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: filteredSchema,
      },
    });

    const result = await model.generateContent([JSON_EXTRACTION_SYSTEM_PROMPT, text]);

    const json = JSON.parse(result.response.text());

    const end = performance.now();

    const inputTokens = result.response.usageMetadata.promptTokenCount;
    const outputTokens = result.response.usageMetadata.candidatesTokenCount;
    const inputCost = calculateTokenCost(this.model, 'input', inputTokens);
    const outputCost = calculateTokenCost(this.model, 'output', outputTokens);

    return {
      json,
      usage: {
        duration: end - start,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputCost,
        outputCost,
        totalCost: inputCost + outputCost,
      },
    };
  }

  // FIXME: JSON output might not be 100% correct yet, because Gemini uses a subset of OpenAPI 3.0 schema
  // https://sdk.vercel.ai/providers/ai-sdk-providers/google-generative-ai#schema-limitations
  async extractFromImage(imagePath: string, schema: JsonSchema) {
    const filteredSchema = this.convertSchemaForGemini(schema);

    // read image and convert to base64
    const response = await fetch(imagePath);
    const imageBuffer = await response.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');

    const start = performance.now();

    const model = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: filteredSchema,
      },
    });

    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType: getMimeType(imagePath),
      },
    };

    const result = await model.generateContent([
      IMAGE_EXTRACTION_SYSTEM_PROMPT,
      imagePart,
    ]);

    const json = JSON.parse(result.response.text());

    const end = performance.now();

    const inputTokens = result.response.usageMetadata.promptTokenCount;
    const outputTokens = result.response.usageMetadata.candidatesTokenCount;
    const inputCost = calculateTokenCost(this.model, 'input', inputTokens);
    const outputCost = calculateTokenCost(this.model, 'output', outputTokens);

    return {
      json,
      usage: {
        duration: end - start,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputCost,
        outputCost,
        totalCost: inputCost + outputCost,
      },
    };
  }

  convertSchemaForGemini(schema) {
    // Deep clone the schema to avoid modifying the original
    const newSchema = JSON.parse(JSON.stringify(schema));

    function processSchemaNode(node) {
      if (!node || typeof node !== 'object') return node;

      // Fix enum type definition
      if (node.type === 'enum' && node.enum) {
        node.type = 'string';
      }
      // Handle case where enum array exists but type isn't specified
      if (node.enum && !node.type) {
        node.type = 'string';
      }

      // Remove additionalProperties constraints
      if ('additionalProperties' in node) {
        delete node.additionalProperties;
      }

      // Handle 'not' validation keyword
      if (node.not) {
        if (node.not.type === 'null') {
          delete node.not;
          node.nullable = false;
        } else {
          processSchemaNode(node.not);
        }
      }

      // Handle arrays
      if (node.type === 'array' && node.items) {
        // Move required fields to items level
        if (node.required) {
          if (!node.items.required) {
            node.items.required = node.required;
          } else {
            node.items.required = [
              ...new Set([...node.items.required, ...node.required]),
            ];
          }
          delete node.required;
        }

        processSchemaNode(node.items);
      }

      // Handle objects with properties
      if (node.properties) {
        Object.entries(node.properties).forEach(([key, prop]) => {
          node.properties[key] = processSchemaNode(prop);
        });
      }

      return node;
    }

    return processSchemaNode(newSchema);
  }
}
