import fs from "fs/promises";
import path from "path";

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

import sizeOf from "image-size";

import {
    BlockWithChildren,
    DateResponse,
    richTextAsPlainText,
} from "./notionHelper";
import { assertUnreachable } from "./utils";
import debug from "debug";
import { RichText } from "./types";
import got from "got";

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
        await fs.mkdir(parentDir);
    }

    let titleDate = date.start.substring(0, 10).replaceAll("-", "");
    const authorStr = authors.join(" ");

    DEBUG("Getting && writing file %s", `${titleDate} ${title} ${authorStr}`);

    if (date.end) {
        let endDateStr = date.end.substring(0, 10).replaceAll("-", "");

        const start = new Date(date.start);
        const end = new Date(date.end);
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

    let parags: Paragraph[] = [
        new Paragraph({
            text: `${titleDate} ${title}`,
            heading: HeadingLevel.HEADING_1,
        }),
        ...(
            await Promise.all(
                page.map(async (block) => await blockToParagRecursive(block, 0))
            )
        ).flat(),

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

// async function blocksToParag(
//     block: BlockWithChildren[],
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

async function blockToParag(
    block: BlockWithChildren<
        | "paragraph"
        | "heading_1"
        | "heading_2"
        | "heading_3"
        | "bulleted_list_item"
        | "numbered_list_item"
        | "quote"
        | "to_do"
        | "toggle"
        | "template"
        | "synced_block"
        | "child_page"
        | "child_database"
        | "equation"
        | "code"
        | "callout"
        | "divider"
        | "breadcrumb"
        | "table_of_contents"
        | "column_list"
        | "column"
        | "link_to_page"
        | "table"
        | "table_row"
        | "embed"
        | "bookmark"
        | "image"
        | "video"
        | "pdf"
        | "file"
        | "audio"
        | "link_preview"
        | "unsupported"
    >,
    indentLevel: number
) {
    let parags: Paragraph[] = [];
    switch (block.type) {
        case "paragraph":
            parags.push(
                richTextToParag(block.paragraph.rich_text, indentLevel)
            );
            break;

        case "numbered_list_item":

        case "bulleted_list_item":

        case "equation":
            IGNORE("Ignoring type %s", block.type);
            break;

        case "heading_1":
            parags.push(
                richTextToParag(
                    block.heading_1.rich_text,
                    indentLevel,
                    HeadingLevel.HEADING_1
                )
            );
            break;
        case "heading_2":
            parags.push(
                richTextToParag(
                    block.heading_2.rich_text,
                    indentLevel,
                    HeadingLevel.HEADING_2
                )
            );
            break;
        case "heading_3":
            parags.push(
                richTextToParag(
                    block.heading_3.rich_text,
                    indentLevel,
                    HeadingLevel.HEADING_3
                )
            );
            break;

        case "quote":
            parags.push(
                richTextToParag(block.quote.rich_text, indentLevel + 0.5)
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
                }),
                richTextToParag(block.image.caption, indentLevel),
                makeNormalParag("")
            );

            break;
        case "video":
        case "file":
        case "audio":
            // file operations
            IGNORE("File ops to be implemented");
            break;

        // case ""
        default:
            // @ts-expect-error Argument of type '"C"' is not assignable to parameter of type 'never'.ts(2345)
            assertUnreachable(block.type, "Switch has a missing clause!", () =>
                console.log({ typeError: "on switch" })
            );
    }
    return parags;
}

async function blockToParagRecursive(
    block: BlockWithChildren,
    indentLevel: number
): Promise<Paragraph[]> {
    let parags: Paragraph[] = await blockToParag(block,indentLevel);

    if (block.has_children) {
        parags = [
            ...parags,
            ...(
                await Promise.all(
                    block.children.map(
                        async (b) =>
                            await blockToParagRecursive(b, indentLevel + 1)
                    )
                )
            ).flat(),
        ];
    }

    return parags;
}

function richTextToParag(
    rt: RichText[],
    indentLevel: number,
    heading?: HeadingLevel
): Paragraph {
    return new Paragraph({
        // text: richTextAsPlainText(rt),
        heading,
        indent: indentLevel
            ? {
                  left: convertInchesToTwip(indentLevel * 0.3),
              }
            : undefined,
        children: rt.map((rtChild) => {
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
        }),
    });
}
