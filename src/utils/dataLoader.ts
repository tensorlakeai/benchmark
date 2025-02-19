import { Input } from '../types';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// Pull JSON files from local folder
export const loadLocalData = (folder: string): Input[] => {
  const files = fs.readdirSync(folder).filter((file) => file.endsWith('.json'));
  const data = files.map((file) => {
    const filePath = path.join(folder, file);
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(fileContent);
  });

  return data;
};

// Query results from the documents table.
export const loadFromDb = async (): Promise<Input[]> => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const result = await pool.query(`
      WITH synthetic_ranked AS (
        SELECT
          url AS "imageUrl",
          config AS "metadata",
          schema AS "jsonSchema",
          extracted_json AS "trueJsonOutput",
          markdown AS "trueMarkdownOutput",
          ROW_NUMBER() OVER (
            PARTITION BY config->>'format'
            ORDER BY created_at
          ) as rn
        FROM documents
        WHERE is_synthetic = true
      )
      SELECT
        url AS "imageUrl",
        config AS "metadata",
        schema AS "jsonSchema",
        extracted_json AS "trueJsonOutput",
        markdown AS "trueMarkdownOutput"
      FROM documents
      WHERE is_synthetic = false
      UNION ALL
      SELECT
        "imageUrl",
        "metadata",
        "jsonSchema",
        "trueJsonOutput",
        "trueMarkdownOutput"
      FROM synthetic_ranked
      WHERE rn <= 10;
    `);

    return result.rows as Input[];
  } catch (error) {
    console.error('Error querying data from PostgreSQL:', error);
    throw error;
  } finally {
    await pool.end();
  }
};
