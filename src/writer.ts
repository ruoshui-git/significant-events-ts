import debug from "debug";
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
import { BlockType, RichText } from "./types";
import { assertUnreachable } from "./utils";
import * as Peeking from "./peeking";

import assert from "assert/strict";

const DEBUG = debug("writer.ts");
const IGNORE = DEBUG.extend("ignore");
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

export async function writePage(
    date: DateResponse,
    title: string,
    page: BlockWithChildren[],
    authors: string[],
    parentDir?: string
) {
    if (parentDir && !(await dirExists(parentDir))) {
        await fs.mkdir(parentDir, { recursive: true });
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

    DEBUG("Getting && writing file %s", `${titleDate} ${title} ${authorStr}`);

    let parags: Paragraph[] = [
        new Paragraph({
            text: `${titleDate} ${title}`,
            heading: HeadingLevel.HEADING_1,
        }),
        // ...(
        //     await Promise.all(
        //         page.map(async (block) => await blockToParagRecursive(block, 0))
        //     )
        // ).flat(),
        ...(await blockListToParag(page, 0)),

        makeNormalParag(""),
        makeNormalParag(`记录人：${authorStr}`),
        makeNormalParag(titleDate),
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
    let filename = `${titleDate} ${title} ${authorStr}.docx`;
    filename = parentDir ? path.join(parentDir, filename) : filename;
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
    indentLevel: number
): Promise<Paragraph[]> {
    const parags: Paragraph[] = [];
    for (const [index, item] of list.entries()) {
        let rt = item.numbered_list_item.rich_text;

        // prepend index to item, as regular text, not as a num list in Word b/c it's too complicated
        rt[0].plain_text = `${index + 1}. ${rt[0].plain_text}`;
        parags.push(richTextToParag({ rt, indentLevel }));
        if (item.has_children) {
            parags.push(
                ...(await blockListToParag(item.children, indentLevel + 1))
            );
        }
    }

    return parags;
}

async function bulletListToParags(
    list: BlockWithChildren<"bulleted_list_item">[],
    indentLevel: number
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
                            indentLevel + 1
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
    indentLevel: number
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

            parags.push(...(await numListToParags(list, indentLevel)));
        } else if (block.type === "bulleted_list_item") {
            const list = getContinuousBlocksByType(
                blocksIter,
                "bulleted_list_item"
            );
            parags.push(...(await bulletListToParags(list, indentLevel)));
        } else {
            // only do normal ops (including advancing iter) if it's not a list item
            parags.push(...(await blockToParag(block, indentLevel)));

            if (block.has_children) {
                // recurse
                parags.push(
                    ...(await blockListToParag(block.children, indentLevel + 1))
                );
            }

            blocksIter.next();
        }
        blockIterVal = blocksIter.peek();
    }

    return parags;
}

async function blockToParag(block: BlockWithChildren, indentLevel: number) {
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
            IGNORE("Ignoring type %s", block.type);
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
            IGNORE("Ignoring type %s", block.type);
            break;

        case "image":
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
            DEBUG("Image size: %d by %d", dim.height, dim.width);
            DEBUG("Displaying at: %d by %d", height, width);

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

            let caption = block.image.caption;
            if (caption.length > 0) {
                caption[0].plain_text = `（${caption[0].plain_text}`;
                caption[caption.length - 1].plain_text = `${
                    caption[caption.length - 1].plain_text
                }）`;
                parags.push(richTextToParag({ rt: caption, indentLevel }));
            }
            
            parags.push(makeNormalParag(""));

            break;
        case "video":
        case "audio":
        case "file":
            // file operations
            IGNORE("File ops to be implemented");
            break;

        // case ""
        default:
            // // @ts-expect-error Argument of type '"C"' is not assignable to parameter of type 'never'.ts(2345)
            assertUnreachable(block, "Switch has a missing clause!", () =>
                console.log({ typeError: "on switch" })
            );
    }
    return parags;
}

interface RtParagConfig {
    rt: RichText[];
    indentLevel: number;
    heading?: HeadingLevel;
    bullet?: boolean;
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
