## Run OCR benchmark using tensorlake's python SDK

### Quick Start

1. install the SDK

```pip install tensorlake```

2. Sign up and get an Tensorlake [API Key](https://cloud.tensorlake.ai/)

3. Run benchmark

```python tensorlake/omni_ocr_benchmarking.py```

4. Evaluation 

```ts-node tensorlake/compute_metrics.ts <input_jsonl> <output_dir> [output_file_name]```
