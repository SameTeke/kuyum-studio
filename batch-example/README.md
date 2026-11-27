# Resumable product-photo conversion

This standalone Node.js example turns a flat folder of JPEG, PNG and WebP files into WebP images for a wholesale catalogue. It keeps the filename stem as the product reference, applies the input orientation, and fits each image inside 1536 × 1536 pixels. Smaller images retain their dimensions.

## Try it

From the project root, with Node.js 24 or later:

```sh
cd batch-example
npm ci
npm run batch -- examples/input work/demo
npm run batch -- examples/input work/demo
npm test
```

The first run converts two synthetic images. The second verifies and skips both. Compare the [sample inputs](./examples/input/) with the [WebP outputs](./examples/output/). The [ring catalogue](../sample-catalogue.pdf) in the main project uses real product photographs. This command-line example runs entirely on the local machine.

For another collection, pass its input folder and a separate, initially empty output folder. After an interruption, use the same two paths. Keep each output folder dedicated to that input collection.

## What survives an interruption?

For each file the worker hashes the source bytes and conversion settings. It stages the completed WebP, publishes it with a rename, then commits a receipt containing the output hash to a local SQLite database. A restart checks both the receipt and the file on disk. If the process stopped between publishing the image and committing the receipt, the next run can safely rebuild that image. The database write lock serializes workers targeting the same output folder.

A damaged input appears in `report.json` with its name and failure reason. Other products continue. Replacing a bad input, changing a valid input or losing an output makes that product eligible on the next run. Two input names that would overwrite the same WebP are both reported. The output folder retains earlier exports when input files are removed.

The report lists converted, skipped and failed files, and the elapsed time. The command exits with 0 on success, 1 for file failures, 2 for a setup error, or 130 after a handled interruption.

## Measured run

On one Windows workstation with Node.js 24.19 and Sharp 0.35.4, the worker converted **16 prepared 900 × 900 ring photographs in 886 ms**. A second pass verified all 16 outputs in **33 ms**, with zero conversions. These are single-run measurements of the batch loop, excluding process startup and PDF export.

The five integration tests cover a corrupt image followed by a valid one, changed inputs and damaged outputs, filename collisions, recovery after killing a worker process, and overlapping runs.
