export function optimize(options: {
  inputPath: string;
  outputPath: string;
  blockMapPath?: string;
}): Promise<void>;

export function compare(
  oldFile: string,
  newFile: string,
): Promise<{
  downloadSize: number;
  modifiedFiles: Array<{
    resolvedPath: string;
    originalPath: string;
    subPath?: string;
    resolvedOffset: number;
    fileOffset: number;
    zipOffset: number;
    size: number;
  }>;
}>;
