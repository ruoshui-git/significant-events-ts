// import debug from "debug";
import {
    convertInchesToTwip,
    Document,
    ExternalHyperlink,
    HeadingLevel,
    ImageRun,
    Packer,
    Paragraph,
    ParagraphChild,
    SectionType,
    TextRun,
    UnderlineType,
} from "docx";
import fs from "fs/promises";
import got from "got";
import sizeOf from "image-size";
import path from "path";
import { BlockWithChildren, DateResponse } from "./notionHelper";
import * as Peeking from "./peeking";
import { BlockType, RichText } from "./types";
import { assertUnreachable } from "./utils";

import { getColoredLogger } from "./coloredLogger";

import assert from "assert/strict";

const log = getColoredLogger();
// const DEBUG = debug("writer.ts");
// const IGNORE = DEBUG.extend("ignore");
const STYLES_PROMISE = fs.readFile("./styles.xml", { encoding: "utf-8" });
const MAX_IMAGE_WIDTH = 650;

async function dirExists(dir: string): Promise<boolean> {
    try {
        await fs.access(dir);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Make dir if doesn't exist
 * @param dir Name of dir
 */
async function mkdirF(dir: string) {
    if (!(await dirExists(dir))) {
        await fs.mkdir(dir, { recursive: true });
    }
}

export interface WritePageOpts {
    date: DateResponse;
    title: string;
    page: BlockWithChildren[];
    authors: string[];
    lastEditedTime: Date;
    parentDir?: string;
}

export async function writePage({
    date,
    title,
    page,
    authors,
    parentDir,
    lastEditedTime,
}: WritePageOpts) {
    if (parentDir) {
        await mkdirF(parentDir);
    }

    let titleDate = date.start.substring(0, 10).replaceAll("-", "");
    const authorStr = authors.join(" ");

    if (date.end) {
        let endDateStr = date.end.substring(0, 10).replaceAll("-", "");

        const startParts = date.start.split("-");
        const endParts = date.end.split("-");

        const start = new Date(
            Number.parseInt(startParts[0]),
            Number.parseInt(startParts[1]) - 1,
            Number.parseInt(startParts[2])
        );
        const end = new Date(
            Number.parseInt(endParts[0]),
            Number.parseInt(endParts[1]) - 1,
            Number.parseInt(endParts[2])
        );

        // const start = new Date(date.start);
        // const end = new Date(date.end);
        if (start.getFullYear() === end.getFullYear()) {
            if (start.getMonth() === end.getMonth()) {
                if (start.getDate() === end.getDate()) {
                    // same date, do nothing
                } else {
                    titleDate = `${titleDate}-${endDateStr.substring(6, 8)}`;
                }
            } else {
                titleDate = `${titleDate}-${endDateStr.substring(4, 8)}`;
            }
        } else {
            titleDate = `${titleDate}-${endDateStr}`;
        }
    }

    const fullTitle = `${titleDate} ${title}`;

    let filename = `${fullTitle} ${authorStr}.docx`;
    filename = parentDir ? path.join(parentDir, filename) : filename;
    let fullDirname = filename.substring(0, filename.lastIndexOf("."));

    log.info("Getting && writing docx", `${fullTitle} ${authorStr}`);

    let parags: Paragraph[] = [
        new Paragraph({
            text: fullTitle,
            heading: HeadingLevel.HEADING_1,
        }),
        // ...(
        //     await Promise.all(
        //         page.map(async (block) => await blockToParagRecursive(block, 0))
        //     )
        // ).flat(),
        ...(await blockListToParag(page, 0, fullDirname)),

        makeNormalParag(""),
        makeNormalParag(
            authorStr.endsWith("软件") ? `${authorStr}发布` : `${authorStr}记录`
        ),
        makeNormalParag(
            `${lastEditedTime.getFullYear()}年${
                lastEditedTime.getMonth() + 1
            }月${lastEditedTime.getDate()}日`
        ),
    ];

    const doc = new Document({
        title,
        externalStyles: await STYLES_PROMISE,
        sections: [
            {
                properties: {
                    type: SectionType.CONTINUOUS,
                },
                children: parags,
            },
        ],
    });

    const buf = await Packer.toBuffer(doc);
    try {
        await fs.writeFile(filename, buf);
    } catch (e) {
        console.error(`fs error: ${e}`);
    }
}

function makeNormalParag(s: string): Paragraph {
    return new Paragraph({
        style: "Normal",
        text: s,
    });
}

// function isBlockOfType(
//     block: BlockWithChildren,
//     t: BlockType
// ): block is BlockWithChildren<typeof t> {
//     return block.type === t;
// }

function isBlockOfTypeT<T extends BlockType>(
    block: BlockWithChildren,
    t: T
): block is BlockWithChildren<T> {
    return block.type === t;
}

/**
 *
 * @param iter Peeking iterator
 * @param type Type of block to filter with
 * @returns All the continuous bloc of blocks with type `type`
 *
 * If the value doesn't match arg `type`, it's not consumed.
 */
function getContinuousBlocksByType<T extends BlockType>(
    iter: Peeking.PeekingIterator<BlockWithChildren>,
    type: T
): BlockWithChildren<T>[] {
    const blocks: BlockWithChildren<T>[] = [];

    let curr = iter.peek();
    while (!curr.done) {
        if (!isBlockOfTypeT(curr.value, type)) {
            // if (curr.value.type !== type)
            return blocks;
        } else {
            blocks.push(iter.next().value);
        }
        curr = iter.peek();
    }

    assert.ok(blocks.length > 0);
    return blocks;
}

async function numListToParags(
    list: BlockWithChildren<"numbered_list_item">[],
    indentLevel: number,
    docxFilename: string
): Promise<Paragraph[]> {
    const parags: Paragraph[] = [];
    for (const [index, item] of list.entries()) {
        let rt = item.numbered_list_item.rich_text;

        // prepend index to item, as regular text, not as a num list in Word b/c it's too complicated
        rt[0].plain_text = `${index + 1}. ${rt[0].plain_text}`;
        parags.push(richTextToParag({ rt, indentLevel }));
        if (item.has_children) {
            parags.push(
                ...(await blockListToParag(
                    item.children,
                    indentLevel + 1,
                    docxFilename
                ))
            );
        }
    }

    return parags;
}

async function bulletListToParags(
    list: BlockWithChildren<"bulleted_list_item">[],
    indentLevel: number,
    docxFilename: string
): Promise<Paragraph[]> {
    return (
        await Promise.all(
            list.flatMap(async (item) => {
                const l = [
                    richTextToParag({
                        rt: item.bulleted_list_item.rich_text,
                        indentLevel: indentLevel,
                    }),
                ];
                if (item.has_children) {
                    l.push(
                        ...(await blockListToParag(
                            item.children,
                            indentLevel + 1,
                            docxFilename
                        ))
                    );
                }
                return l;
            })
        )
    ).flat();
}

async function blockListToParag(
    blocks: BlockWithChildren[],
    indentLevel: number,
    docxFilename: string
): Promise<Paragraph[]> {
    let parags: Paragraph[] = [];

    // const blocksIter = blocks[Symbol.iterator]();
    const blocksIter = Peeking.fromIterable(blocks);

    let blockIterVal = blocksIter.peek();
    while (!blockIterVal.done) {
        blockIterVal = blocksIter.peek();
        const block = blockIterVal.value;

        if (block.type === "numbered_list_item") {
            const list = getContinuousBlocksByType(
                blocksIter,
                "numbered_list_item"
            );

            parags.push(
                ...(await numListToParags(list, indentLevel, docxFilename))
            );
        } else if (block.type === "bulleted_list_item") {
            const list = getContinuousBlocksByType(
                blocksIter,
                "bulleted_list_item"
            );
            parags.push(
                ...(await bulletListToParags(list, indentLevel, docxFilename))
            );
        } else {
            // only do normal ops (including advancing iter) if it's not a list item
            parags.push(
                ...(await blockToParag(block, indentLevel, docxFilename))
            );

            if (block.has_children) {
                // recurse
                parags.push(
                    ...(await blockListToParag(
                        block.children,
                        indentLevel + 1,
                        docxFilename
                    ))
                );
            }

            blocksIter.next();
        }
        blockIterVal = blocksIter.peek();
    }

    return parags;
}

async function blockToParag(
    block: BlockWithChildren,
    indentLevel: number,
    docxFilename: string
) {
    let parags: Paragraph[] = [];
    switch (block.type) {
        case "paragraph":
            parags.push(
                richTextToParag({ rt: block.paragraph.rich_text, indentLevel })
            );
            break;

        case "bulleted_list_item":
            throw new Error(`Should not reach type ${block.type}`);
        case "numbered_list_item":
            throw new Error(`Should not reach type ${block.type}`);

        case "equation":
            log.warn("Ignoring type %s", block.type);
            break;

        case "heading_1":
            parags.push(
                richTextToParag({
                    rt: block.heading_1.rich_text,
                    indentLevel,
                    heading: HeadingLevel.HEADING_1,
                })
            );
            break;
        case "heading_2":
            parags.push(
                richTextToParag({
                    rt: block.heading_2.rich_text,
                    indentLevel,
                    heading: HeadingLevel.HEADING_2,
                })
            );
            break;
        case "heading_3":
            parags.push(
                richTextToParag({
                    rt: block.heading_3.rich_text,
                    indentLevel,
                    heading: HeadingLevel.HEADING_3,
                })
            );
            break;

        case "quote":
            parags.push(
                richTextToParag({
                    rt: block.quote.rich_text,
                    indentLevel: indentLevel + 0.5,
                })
            );
            break;

        case "column":
        case "toggle":
        case "divider":
        case "to_do":
        case "callout":
        case "column_list":
        case "breadcrumb":
        case "child_database":
        case "child_page":
        case "code":
        case "bookmark":
        case "embed":
        case "link_preview":
        case "link_to_page":
        case "pdf":
        case "synced_block":
        case "table":
        case "table_of_contents":
        case "table_row":
        case "template":
        case "unsupported":
            log.warn("Ignoring type", block.type);
            break;

        case "image": {
            let url: string;
            if (block.image.type == "external") {
                url = block.image.external.url;
            } else {
                url = block.image.file.url;
            }
            const data = await got(url).buffer();
            const dim = sizeOf(data);
            // DEBUG("Image: %s", JSON.stringify(dim));
            let height = dim.height || 400;
            let width = dim.width || 400;
            if (width && width > MAX_IMAGE_WIDTH) {
                const scale = width / MAX_IMAGE_WIDTH;
                width /= scale;
                height /= scale;
            }
            log.info(`Image size: ${dim.height} by ${dim.width}`);
            log.info(`Displaying at: ${height} by ${width}`);

            parags.push(
                new Paragraph({
                    children: [
                        new ImageRun({
                            data,
                            transformation: {
                                height,
                                width,
                            },
                        }),
                    ],
                })
            );

            let captionParag = captionToParag(block.image.caption, indentLevel);
            if (captionParag) {
                parags.push(captionParag);
            }
            parags.push(makeNormalParag(""));

            break;
        }
        case "video": {
            await fileOps("video", "视频");
            break;
        }
        case "audio": {
            await fileOps("audio", "音频");
            break;
        }
        case "file": {
            await fileOps("file", "文件");
            break;
        }

        // case ""
        default:
            assertUnreachable(block, "Switch has a missing clause!", () =>
                console.log({ typeError: "on switch" })
            );
    }
    return parags;

    async function fileOps(
        type: "video" | "audio" | "file",
        chineseText: string
    ) {
        let url: string;
        // block = block as BlockWithChildren<'video'|'audio'|'file'>;
        // @ts-ignore
        if (block[type].type === "external") {
            // @ts-ignore
            url = block[type].external.url;
        } else {
            // @ts-ignore
            url = block[type].file.url;
        }
        await mkdirF(docxFilename);
        let parsedBufferName = url.split("/").pop()?.split("?").shift();
        if (!parsedBufferName) {
            parsedBufferName = `未命名${chineseText}`;
        }
        let bufferName = decodeURIComponent(parsedBufferName).replaceAll(
            "_",
            " "
        );
        log.info(`Downloading ${type} ${bufferName}...`);
        const data = await got(url).buffer();

        log.info(`Writing buffer to file...`);
        await fs.writeFile(path.join(docxFilename, bufferName), data);

        parags.push(makeNormalParag(`【${chineseText}：${bufferName}】`));
        // @ts-ignore
        let captionParag = captionToParag(block[type].caption, indentLevel);
        if (captionParag) {
            parags.push(captionParag);
        }
        parags.push(makeNormalParag(""));
    }
}

interface RtParagConfig {
    rt: RichText[];
    indentLevel: number;
    heading?: HeadingLevel;
    bullet?: boolean;
}

/**
 * Convert a video or audio caption to Parag (add parens around)
 * @param caption RichText
 * @param indentLevel number
 * @returns Docx Parag
 */
function captionToParag(caption: RichText[], indentLevel: number) {
    if (caption.length > 0) {
        caption[0].plain_text = `（${caption[0].plain_text}`;
        caption[caption.length - 1].plain_text = `${
            caption[caption.length - 1].plain_text
        }）`;
        return richTextToParag({ rt: caption, indentLevel });
    }
}

// async function blockToParagRecursive(
//     block: BlockWithChildren,
//     indentLevel: number
// ): Promise<Paragraph[]> {
//     let parags: Paragraph[] = await blockToParag(block, indentLevel);

//     if (block.has_children) {
//         parags = [
//             ...parags,
//             ...(
//                 await Promise.all(
//                     block.children.map(
//                         async (b) =>
//                             await blockToParagRecursive(b, indentLevel + 1)
//                     )
//                 )
//             ).flat(),
//         ];
//     }

//     return parags;
// }

function richTextToParag({
    rt,
    indentLevel,
    heading,
    bullet,
}: RtParagConfig): Paragraph {
    return new Paragraph({
        // text: richTextAsPlainText(rt),
        heading,
        bullet: bullet
            ? {
                  level: indentLevel,
              }
            : undefined,
        indent: indentLevel
            ? {
                  left: convertInchesToTwip(indentLevel * 0.3),
              }
            : undefined,
        children: richTextToTextRun(rt),
    });
}

function richTextToTextRun(rt: RichText[]): ParagraphChild[] {
    return rt.map((rtChild) => {
        let r = new TextRun({
            text: rtChild.plain_text,
            // bold: rtChild.annotations.bold,
            italics: rtChild.annotations.italic,
            strike: rtChild.annotations.strikethrough,
            underline: rtChild.annotations.underline
                ? {
                      color: "000000",
                      type: UnderlineType.SINGLE,
                  }
                : undefined,
        });

        if (rtChild.href) {
            return new ExternalHyperlink({
                children: [r],
                link: rtChild.href,
            });
        } else {
            return r;
        }
    });
}
