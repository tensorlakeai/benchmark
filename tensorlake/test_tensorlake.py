#!/usr/bin/env python3

import json
import os
import sys
import time
from tensorlake.documentai import DocumentAI
from tensorlake.documentai.parse import ExtractionOptions, ParsingOptions

# Set up API key
API_KEY = os.getenv("TENSORLAKE_API_KEY", "tl_apiKey_xxx")

# Test image URL
IMAGE_URL = "https://omni-demo-data.s3.us-east-1.amazonaws.com/templates/receipt.png"

# Sample schema JSON
SAMPLE_SCHEMA = {
    "title": "Receipt_Schema",
    "type": "object",
    "properties": {
        "date": {
            "type": "string",
            "description": "The date on the receipt"
        },
        "total_amount": {
            "type": "string",
            "description": "The total amount on the receipt"
        },
        "merchant_name": {
            "type": "string",
            "description": "The name of the merchant"
        },
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string"
                    },
                    "quantity": {
                        "type": "string"
                    },
                    "price": {
                        "type": "string"
                    }
                }
            }
        }
    }
}

def process_json_schema(schema):
    """Process JSON schema to match TensorLake requirements"""
    import json
    import re
    
    # Convert to string if it's a dict
    if isinstance(schema, dict):
        schema_str = json.dumps(schema)
    else:
        schema_str = schema
    
    # Load as JSON
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
            for key, value in list(obj.items()):
                process_schema(value)
        elif isinstance(obj, list):
            # Recursively process all items in the list
            for item in obj:
                process_schema(item)
    
    # Process the schema
    process_schema(schema)
    
    # Return as a JSON string
    return json.dumps(schema)

def download_image(url, output_path="temp_image.png"):
    """Download an image from a URL"""
    import requests
    
    response = requests.get(url)
    response.raise_for_status()
    
    with open(output_path, 'wb') as f:
        f.write(response.content)
    
    return output_path

def main():
    """Test TensorLake API"""
    print("Testing TensorLake API...")
    
    try:
        # Initialize the DocumentAI client
        doc_ai = DocumentAI(api_key=API_KEY)
        print("✅ Initialized DocumentAI client")
        
        # Download the image
        image_path = download_image(IMAGE_URL)
        print(f"✅ Downloaded image to {image_path}")
        
        # Process the schema
        processed_schema = process_json_schema(SAMPLE_SCHEMA)
        print("✅ Processed schema")
        print(f"Schema: {processed_schema}")
        
        # Upload the image
        file_id = doc_ai.upload(path=image_path)
        print(f"✅ Uploaded image with file_id: {file_id}")
        
        # The key is to pass a string to the ExtractionOptions
        # Create options with a string schema
        print('type of the schema ##########', type(processed_schema))
        extraction_options = ExtractionOptions(schema=processed_schema)  # Pass as string
        parse_options = ParsingOptions(extraction_options=extraction_options)
        
        # Parse the file
        job_id = doc_ai.parse(file_id, options=parse_options)
        print(f"✅ Started parsing job: {job_id}")
        
        # Wait for job to complete
        while True:
            result = doc_ai.get_job(job_id=job_id)
            if result.status in ["processing", "pending"]:
                print(f"⏳ Job status: {result.status}, waiting...")
                time.sleep(5)
            else:
                if result.status == "successful":
                    print(f"✅ Job completed successfully")
                    break
                else:
                    raise Exception(f"Job failed with status: {result.status}")
        
        # Extract the structured data
        output = result.outputs
        print("✅ Got outputs")
        
        # Print structured data
        if hasattr(output, 'structured_data') and output.structured_data:
            if hasattr(output.structured_data, 'pages') and output.structured_data.pages:
                if len(output.structured_data.pages) > 0 and hasattr(output.structured_data.pages[0], 'data'):
                    structured_data = output.structured_data.pages[0].data
                    print(f"📄 Structured data: {json.dumps(structured_data, indent=2)}")
                else:
                    print("❌ No data in first page")
            else:
                print("❌ No pages in structured_data")
        else:
            print("❌ No structured_data in output")
        
        # Clean up
        os.remove(image_path)
        print(f"✅ Cleaned up temp image")
        
    except Exception as e:
        import traceback
        print(f"❌ Error: {str(e)}")
        print(traceback.format_exc())
        return 1
    
    return 0

if __name__ == "__main__":
    sys.exit(main()) 