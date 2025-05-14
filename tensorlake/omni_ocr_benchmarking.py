import json
import time
import json
import asyncio
import os
import re
from typing import List, Union, Dict
from pydantic import BaseModel, Field, Json
import pandas as pd
from concurrent.futures import ThreadPoolExecutor

from tensorlake.documentai import DocumentAI
from tensorlake.documentai.parse import (
    ExtractionOptions,
    ParsingOptions,
    ChunkingStrategy,
    TableParsingStrategy,
)


# Function to process JSON schema title
def process_json_schema(schema_str):
    schema = json.loads(schema_str)
    
    # Process title if it exists
    if 'title' in schema:
        schema['title'] = re.sub(r'[^a-zA-Z0-9_-]', '_', schema['title'])
    
    # Function to recursively process schema
    def process_schema(obj):
        if isinstance(obj, dict):
            # Remove problematic fields if they exist
            for field in ['format', 'not', 'pattern']:
                if field in obj:
                    del obj[field]
            # Fix enum type
            if 'type' in obj and obj['type'] == 'enum':
                obj['type'] = 'string'
            # Recursively process all values in the dictionary
            for value in obj.values():
                process_schema(value)
        elif isinstance(obj, list):
            # Recursively process all items in the list
            for item in obj:
                process_schema(item)
    
    # Process the schema
    process_schema(schema)
    
    return json.dumps(schema)
# prod
# you will need to get your own API key from tensorlake at https://www.tensorlake.ai/
API_KEY = "tl_XXXX"

doc_ai = DocumentAI(api_key=API_KEY)

image_path = '/home/ubuntu/Shanshan/dataset/benchmarking/omniocr/test'

# Use a dictionary to maintain file_id to prediction mapping
results: Dict[str, dict] = {}
errors = []  # Track any errors that occur

async def process_single_file(data: dict) -> dict:
    job_id = None  # Initialize job_id at the start
    schema = process_json_schema(data['json_schema'])  # Process schema at the start
    try:
        img_id = data['file_name']
        
        print('\nProcessing file:', img_id)
        
        img_path = os.path.join(image_path, img_id)
        
        # upload image
        try:
            file_id = doc_ai.upload(path=img_path)
        except Exception as e:
            print(f"Error uploading {img_id}: {str(e)}")
            errors.append({"file": img_id, "error": f"Upload failed: {str(e)}", "job_id": None})
            return {"img_id": img_id, "result": None, "job_id": None, "error": f"Upload failed: {str(e)}", "schema": schema, "md_text": None}
        
        # parse image
        try:
            job_id = doc_ai.parse(
                file_id,
                options=ParsingOptions(
                    extraction_options=ExtractionOptions(schema=schema),
                    structured_extraction_skip_ocr=True,
                    chunking_strategy=ChunkingStrategy.PAGE,
                    # table_parsing_strategy=TableParsingStrategy.TSR,
                ),
            )
        except Exception as e:
            print(f"Error parsing {img_id}: {str(e)}")
            errors.append({"file": img_id, "error": f"Parse failed: {str(e)}", "job_id": job_id})
            return {"img_id": img_id, "result": None, "job_id": job_id, "error": f"Parse failed: {str(e)}", "schema": schema, "md_text": None}
        
        # wait for job to complete
        try:
            while True:
                result = doc_ai.get_job(job_id=job_id)
                if result.status in ["processing", "pending"]:
                    print(f"Waiting for job {job_id} to complete...")
                    await asyncio.sleep(5)
                else:
                    if result.status == "successful":
                        print(f"Job {job_id} completed successfully")
                        break
                    else:
                        error_msg = f"Job failed with status: {result.status}"
                        errors.append({"file": img_id, "error": error_msg, "job_id": job_id})
                        raise Exception(error_msg)
        except Exception as e:
            print(f"Error waiting for job completion for {img_id}: {str(e)}")
            errors.append({"file": img_id, "error": f"Job completion failed: {str(e)}", "job_id": job_id})
            return {"img_id": img_id, "result": None, "job_id": job_id, "error": str(e), "schema": schema, "md_text": None}
        
        out_data = result.outputs.structured_data.pages[0].data
        md_text = result.outputs.chunks[0].content.strip() if result.outputs.chunks else None
        
        if out_data:
            print('Added prediction for:', img_id)
            return {"img_id": img_id, "result": out_data, "job_id": job_id, "error": None, "schema": schema, "md_text": md_text}
        else:
            print('No prediction data for:', img_id)
            errors.append({"file": img_id, "error": "No prediction data", "job_id": job_id})
            return {"img_id": img_id, "result": None, "job_id": job_id, "error": "No prediction data", "schema": schema, "md_text": md_text}
            
    except Exception as e:
        error_msg = str(e)
        print(f"Error processing {img_id if 'img_id' in locals() else 'unknown file'}: {error_msg}")
        errors.append({"file": img_id if 'img_id' in locals() else 'unknown', "error": error_msg, "job_id": job_id})
        return {"img_id": img_id if 'img_id' in locals() else 'unknown', "result": None, "job_id": job_id, "error": error_msg, "schema": schema, "md_text": None}

async def main():
    print("Starting processing...")
    labels = '/home/ubuntu/Shanshan/dataset/benchmarking/omniocr/test/metadata.jsonl'
    
    # Read items from jsonl file
    items_to_process = []
    original_metadata = []
    with open(labels, 'r') as f:
        for line in f:
            data = json.loads(line)
            original_metadata.append(data)
            items_to_process.append(data)
            # # Break after collecting 10 items for quick testing
            # if len(items_to_process) >= 2:
            #     break
    
    print(f"Processing {len(items_to_process)} items from metadata.jsonl")
    
    # Process files in parallel
    tasks = [process_single_file(item) for item in items_to_process]
    processed_results = await asyncio.gather(*tasks)
    
    # Collect results
    for result in processed_results:
        img_id = result["img_id"]
        results[img_id] = {
            "prediction": result["result"],
            "job_id": result["job_id"],
            "error": result["error"],
            "schema": result["schema"],
            "md_text": result["md_text"]
        }

    print("\nFinal data collection:")
    print("Number of files processed:", len(results))
    
    # Save predictions to CSV
    try:
        # Create DataFrame from the results dictionary
        preds_df = pd.DataFrame([
            {
                'file_id': file_id,
                'prediction': data['prediction'],
                'job_id': data['job_id'],
                'error': data['error'],
                'schema': data['schema'],
                'md_text': data['md_text']
            }
            for file_id, data in results.items()
        ])
        print("\nDataFrame before saving:")
        print(preds_df)
    
        preds_df.to_csv('tensorlake_predictions.csv', index=False)
        print(f"\nSuccessfully saved predictions for {len(results)} files to CSV")
    except Exception as e:
        print(f"Error saving predictions to CSV: {str(e)}")

    # Save updated metadata as jsonl
    try:
        with open('tensorlake_metadata_with_predictions.jsonl', 'w') as f:
            for item in original_metadata:
                file_id = item['file_name']
                if file_id in results:
                    # Add prediction fields to the original item
                    item['predictedJson'] = results[file_id]['prediction']
                    item['predictedMarkdown'] = results[file_id]['md_text']
                    item['job_id'] = results[file_id]['job_id']
                    item['error'] = results[file_id]['error']
                f.write(json.dumps(item) + '\n')
        print(f"\nSuccessfully saved updated metadata for {len(original_metadata)} items to jsonl")
    except Exception as e:
        print(f"Error saving updated metadata to jsonl: {str(e)}")

    # Save error log
    if errors:
        try:
            error_df = pd.DataFrame(errors)
            error_df.to_csv('tensorlake_processing_errors.csv', index=False)
            print(f"Saved error log with {len(errors)} errors")
        except Exception as e:
            print(f"Error saving error log: {str(e)}")

if __name__ == "__main__":
    asyncio.run(main())


        
