export function optimize(options: {
  inputPath: string;
  outputPath: string;
  blockMapPath?: string;
}): Promise<void>;

export function compare(oldFile: string, newFile: string);
