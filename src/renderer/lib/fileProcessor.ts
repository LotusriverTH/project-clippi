import * as path from "path";

import fg from "fast-glob";
import fs from "fs-extra";

import { ComboType, DolphinComboQueue, SlippiGame, SlpRealTime, SlpStream } from "@vinceau/slp-realtime";

import { deleteFile, pipeFileContents } from "common/utils";
import { parseFileRenameFormat } from "./context";
import { comboFilter } from "./realtime";

interface FileProcessorOptions {
    filesPath: string;
    renameFiles: boolean;
    findCombos: boolean;
    includeSubFolders?: boolean;
    deleteZeroComboFiles?: boolean;
    outputFile?: string;
    renameTemplate?: string;
}

interface ProcessOutput {
    combosFound: number;
    filesProcessed: number;
    timeTaken: number; // in seconds
}

export const renameFormat = (filename: string, format: string): string => {
    const game = new SlippiGame(filename);
    const settings = game.getSettings();
    const metadata = game.getMetadata();
    const fullFilename = path.basename(filename);
    return parseFileRenameFormat(format, settings, metadata, fullFilename);
};

const uniqueFilename = (name: string) => {
    const randomSuffix = Math.random().toString(36).slice(2).substring(0, 5);
    const onlyExt = path.extname(name);
    const onlyFilename = path.basename(name, onlyExt);
    const dir = path.dirname(name);
    return path.join(dir, `${onlyFilename}_${randomSuffix}${onlyExt}`);
};

const renameFile = async (currentFilename: string, newFilename: string): Promise<string> => {
    // Return if the new filename is the same as the current name
    const fullFilename = path.basename(currentFilename);
    if (fullFilename === newFilename) {
        console.log("Filename is already named! Skipping rename...");
        return currentFilename;
    }
    // Make sure the new filename doesn't already exist
    const directory = path.dirname(currentFilename);
    let newFullFilename = path.join(directory, newFilename);
    // Make sure the directory exists
    await fs.ensureDir(path.dirname(newFullFilename));
    const exists = await fs.pathExists(newFullFilename);
    if (exists) {
        // Append a random suffix to the end to avoid conflicts
        newFullFilename = uniqueFilename(newFullFilename);
    }
    await fs.rename(currentFilename, newFullFilename);
    console.log(`Renamed ${currentFilename} to ${newFullFilename}`);
    // Return the new filename so we know how to further process it
    return newFullFilename;
};

export interface ProcessResult {
    numCombos?: number;
    newFilename?: string;
    fileDeleted?: boolean;
}

export class FileProcessor {
    private readonly queue = new DolphinComboQueue();
    private stopRequested: boolean = false;

    public stop(): void {
        this.stopRequested = true;
    }

    public async process(
        opts: FileProcessorOptions,
        callback?: (i: number, total: number, filename: string, data: ProcessResult) => void,
    ): Promise<ProcessOutput> {
        const before = new Date();  // Use this to track elapsed time
        this.stopRequested = false;
        this.queue.clear();

        const patterns = ["**/*.slp"];
        const options = {
            absolute: true,
            cwd: opts.filesPath,
            onlyFiles: true,
            deep: opts.includeSubFolders ? undefined : 1,
        };

        let filesProcessed = 0;
        const entries = await fg(patterns, options);
        for (const [i, filename] of (entries.entries())) {
            if (this.stopRequested) {
                break;
            }

            const res = await this._processFile(filename, opts);
            if (callback) {
                callback(i, entries.length, filename, res);
            }
            filesProcessed += 1;
        }

        // Write out files if we found combos
        let totalCombos = 0;
        if (opts.findCombos && opts.outputFile) {
            totalCombos = await this.queue.writeFile(opts.outputFile);
            console.log(`Wrote ${totalCombos} out to ${opts.outputFile}`);
        }

        // Return elapsed time and other stats
        const after = new Date();
        const millisElapsed = Math.abs(after.getTime() - before.getTime());
        return {
            timeTaken: millisElapsed / 1000,
            filesProcessed,
            combosFound: totalCombos,
        };
    }

    private async _processFile(filename: string, options: Partial<FileProcessorOptions>): Promise<ProcessResult> {
        console.log(`Processing file: ${filename}`);
        const res: ProcessResult = {};

        // Handle file renaming
        if (options.renameFiles && options.renameTemplate) {
            res.newFilename = renameFormat(filename, options.renameTemplate);
            filename = await renameFile(filename, res.newFilename);
        }

        // Handle combo finding
        if (options.findCombos) {
            const combos = await findCombos(filename);
            combos.forEach(c => {
                this.queue.addCombo(filename, c);
            });
            // Delete the file if no combos were found
            if (options.deleteZeroComboFiles && combos.length === 0) {
                console.log(`No combos found in ${filename}. Deleting...`);
                await deleteFile(filename);
                res.fileDeleted = true;
            }
            res.numCombos = combos.length;
        }

        return res;
    }
}

export const findCombos = async (filename: string): Promise<ComboType[]> => {
    const combosList = new Array<ComboType>();
    const slpStream = new SlpStream({ singleGameMode: true });
    const realtime = new SlpRealTime();
    realtime.setStream(slpStream);

    realtime.combo.end$.subscribe(payload => {
        const { combo, settings } = payload;
        if (comboFilter.isCombo(combo, settings)) {
            combosList.push(combo);
        }
    });

    await pipeFileContents(filename, slpStream);

    console.log(`Found ${combosList.length} combos in ${filename}`);
    return combosList;
};

export const fileProcessor = new FileProcessor();
