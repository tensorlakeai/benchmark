import { calculateJsonAccuracy, AccuracyResult } from '../src/evaluation/json';
import { calculateTextSimilarity } from '../src/evaluation/text';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

interface MetricsResult {
    file_id: string;
    json: {
        accuracy: number;
        diffStats: any;
        totalFields: number;
    } | null;
    text: {
        similarity: number;
        error?: string;
    } | null;
}

// Function to load files
const loadJsonFile = (filePath: string) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
};

const loadTextFile = (filePath: string) => {
    return fs.readFileSync(filePath, 'utf-8');
};

// Function to save results in the specified format
const saveResults = (doc: any, outputDir: string) => {
    // Create directories if they don't exist
    const groundTruthDir = path.join(outputDir, 'ground_truth');
    const predictionsDir = path.join(outputDir, 'predictions');

    fs.mkdirSync(groundTruthDir, { recursive: true });
    fs.mkdirSync(predictionsDir, { recursive: true });

    const fileId = doc.id?.toString() || doc.file_id?.toString() || doc.file_name || 'unknown';

    // Save ground truth files
    if (doc.true_json_output) {
        fs.writeFileSync(
            path.join(groundTruthDir, `${fileId}.json`),
            typeof doc.true_json_output === 'string'
                ? doc.true_json_output
                : JSON.stringify(doc.true_json_output, null, 2)
        );
    }

    if (doc.true_markdown_output) {
        fs.writeFileSync(
            path.join(groundTruthDir, `${fileId}.txt`),
            doc.true_markdown_output
        );
    }

    // Save prediction files
    if (doc.predictedJson) {
        fs.writeFileSync(
            path.join(predictionsDir, `${fileId}.json`),
            typeof doc.predictedJson === 'string'
                ? doc.predictedJson
                : JSON.stringify(doc.predictedJson, null, 2)
        );
    }

    if (doc.predictedMarkdown) {
        fs.writeFileSync(
            path.join(predictionsDir, `${fileId}.txt`),
            doc.predictedMarkdown
        );
    }
};

// Function to calculate metrics for a single document
const calculateMetrics = (doc: any): MetricsResult | null => {
    // Skip if both predictions are empty
    if (!doc.predictedJson && !doc.predictedMarkdown) {
        return null;
    }

    let jsonResult: AccuracyResult | null = null;
    let textSimilarity: number | null = null;

    // Calculate JSON metrics if prediction exists
    if (doc.predictedJson && doc.true_json_output) {
        let groundTruthJson, predictedJson;
        try {
            groundTruthJson = typeof doc.true_json_output === 'string'
                ? JSON.parse(doc.true_json_output)
                : doc.true_json_output;
            predictedJson = typeof doc.predictedJson === 'string'
                ? JSON.parse(doc.predictedJson)
                : doc.predictedJson;
            jsonResult = calculateJsonAccuracy(groundTruthJson, predictedJson);
        } catch (e) {
            console.warn(`Error parsing JSON for file ${doc.id || doc.file_id || doc.file_name}:`, e);
        }
    }

    // Calculate text metrics if prediction exists
    if (doc.predictedMarkdown && doc.true_markdown_output) {
        try {
            textSimilarity = calculateTextSimilarity(
                doc.true_markdown_output,
                doc.predictedMarkdown
            );
            if (textSimilarity === undefined || textSimilarity === null) {
                console.log(`Warning: Text similarity calculation returned null/undefined for file ${doc.id || doc.file_id || doc.file_name}`);
                textSimilarity = null;
            }
        } catch (e) {
            console.warn(`Error calculating text similarity for file ${doc.id || doc.file_id || doc.file_name}:`, e);
            textSimilarity = null;
        }
    } else {
        console.log(`Debug: File ${doc.id || doc.file_id || doc.file_name} missing text data:`, {
            hasPredicted: !!doc.predictedMarkdown,
            hasGroundTruth: !!doc.true_markdown_output
        });
    }

    const result = {
        file_id: doc.id?.toString() || doc.file_id?.toString() || doc.file_name || 'unknown',
        json: jsonResult ? {
            accuracy: jsonResult.score,
            diffStats: jsonResult.jsonDiffStats,
            totalFields: jsonResult.totalFields
        } : null,
        text: doc.predictedMarkdown && doc.true_markdown_output ? {
            similarity: textSimilarity !== null ? textSimilarity : 0,
            error: textSimilarity === null ? 'Failed to calculate similarity' : undefined
        } : null
    };

    // Debug log for text metrics
    if (doc.predictedMarkdown && doc.true_markdown_output) {
        console.log(`Debug: File ${result.file_id} text metrics:`, {
            hasText: !!result.text,
            hasError: result.text?.error !== undefined,
            similarity: result.text?.similarity
        });
    }

    return result;
};

// Main function to process JSONL file
const processJsonlFile = async (inputJsonlPath: string, outputDir: string, outputFileName: string = 'metrics.json') => {
    const fileStream = fs.createReadStream(inputJsonlPath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    const metrics: any[] = [];
    let skippedFiles = 0;
    const skippedFileIds: any[] = [];

    // Process each line in the JSONL file
    for await (const line of rl) {
        if (!line.trim()) continue;
        let doc;
        try {
            doc = JSON.parse(line);
        } catch (e) {
            console.warn('Skipping malformed JSON line:', e);
            continue;
        }

        // Optionally save files in the specified format
        saveResults(doc, outputDir);

        // Calculate metrics
        const docMetrics = calculateMetrics(doc);
        if (docMetrics) {
            metrics.push(docMetrics);
        } else {
            skippedFiles++;
            skippedFileIds.push(doc.id || doc.file_id || doc.file_name || 'unknown');
        }
    }

    // Calculate averages only for valid metrics
    const validJsonMetrics = metrics.filter(m => m.json !== null);
    const validTextMetrics = metrics.filter(m => m.text !== null && m.text.error === undefined);
    const failedTextMetrics = metrics.filter(m => m.text !== null && m.text.error !== undefined);

    // Debug log for metrics counts
    console.log('\nDebug Metrics Counts:');
    console.log(`Total metrics: ${metrics.length}`);
    console.log(`Valid JSON metrics: ${validJsonMetrics.length}`);
    console.log(`Valid text metrics: ${validTextMetrics.length}`);
    console.log(`Failed text metrics: ${failedTextMetrics.length}`);
    console.log(`Files with text data: ${metrics.filter(m => m.text !== null).length}`);
    console.log(`Files without text data: ${metrics.filter(m => m.text === null).length}`);

    const averageJsonAccuracy = validJsonMetrics.length > 0
        ? validJsonMetrics.reduce((sum, r) => sum + r.json.accuracy, 0) / validJsonMetrics.length
        : 0;
    const averageTextSimilarity = validTextMetrics.length > 0
        ? validTextMetrics.reduce((sum, r) => sum + r.text.similarity, 0) / validTextMetrics.length
        : 0;

    // Log detailed information about failed text calculations
    if (failedTextMetrics.length > 0) {
        console.log('\nFailed Text Calculations:');
        failedTextMetrics.forEach(m => {
            console.log(`File ID: ${m.file_id}`);
            console.log(`Error: ${m.text?.error}`);
        });
    }

    // Output detailed results
    console.log('\nDetailed Results:');
    metrics.forEach(result => {
        console.log(`\nFile ID: ${result.file_id}`);
        if (result.json) {
            console.log('JSON Metrics:');
            console.log(`  Accuracy: ${result.json.accuracy}`);
            console.log(`  Total Fields: ${result.json.totalFields}`);
            console.log('  Diff Stats:', result.json.diffStats);
        }
        if (result.text) {
            console.log('Text Metrics:');
            console.log(`  Similarity: ${result.text.similarity}`);
            if (result.text.error) {
                console.log(`  Error: ${result.text.error}`);
            }
        }
    });

    // Output summary
    console.log('\nSummary:');
    console.log(`Average JSON Accuracy: ${averageJsonAccuracy.toFixed(4)} (${validJsonMetrics.length} valid files)`);
    console.log(`Average Text Similarity: ${averageTextSimilarity.toFixed(4)} (${validTextMetrics.length} valid files)`);
    console.log(`Failed Text Calculations: ${failedTextMetrics.length} files`);
    console.log(`Total Files Processed: ${metrics.length}`);
    console.log(`Skipped Files (Empty Predictions): ${skippedFiles}`);
    if (skippedFiles > 0) {
        console.log('Skipped File IDs:', skippedFileIds);
    }

    // Save metrics to JSON file
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
        path.join(outputDir, outputFileName),
        JSON.stringify({
            summary: {
                averageJsonAccuracy,
                averageTextSimilarity,
                totalFiles: metrics.length,
                skippedFiles,
                validJsonFiles: validJsonMetrics.length,
                validTextFiles: validTextMetrics.length,
                failedTextFiles: failedTextMetrics.length,
                failedTextFileIds: failedTextMetrics.map(m => m.file_id)
            },
            detailed: metrics
        }, null, 2)
    );
    console.log(`\nSaved metrics to ${path.join(outputDir, outputFileName)}`);
};

// Usage: ts-node compute_metrics.ts <input_jsonl> <output_dir> [output_file_name]
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log('Usage: ts-node compute_metrics.ts <input_jsonl> <output_dir> [output_file_name]');
        process.exit(1);
    }
    const [inputJsonlPath, outputDir, outputFileName] = args;
    processJsonlFile(inputJsonlPath, outputDir, outputFileName).catch(e => {
        console.error('Error processing JSONL file:', e);
        process.exit(1);
    });
}