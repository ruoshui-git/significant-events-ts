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
            blocks.push(curr.value);
        }
        iter.next();
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
            parags.push(...(await blockToParag(block, indentLevel)));
        }
        if (block.has_children) {
            // recurse
            parags.push(
                ...(await blockListToParag(block.children, indentLevel + 1))
            );
        }

        blocksIter.next();
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
                }),
                richTextToParag({ rt: block.image.caption, indentLevel }),
                makeNormalParag("")
            );

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

/**
 * (
        | {
              type: "text";
              text: { content: string; link: { url: string } | null };
              annotations: {
                  bold: boolean;
                  italic: boolean;
                  strikethrough: boolean;
                  underline: boolean;
                  code: boolean;
                  color:
                      | "default"
                      | "gray"
                      | "brown"
                      | "orange"
                      | "yellow"
                      | "green"
                      | "blue"
                      | "purple"
                      | "pink"
                      | "red"
                      | "gray_background"
                      | "brown_background"
                      | "orange_background"
                      | "yellow_background"
                      | "green_background"
                      | "blue_background"
                      | "purple_background"
                      | "pink_background"
                      | "red_background";
              };
              plain_text: string;
              href: string | null;
          }
        | {
              type: "mention";
              mention:
                  | {
                        type: "user";
                        user:
                            | { id: string; object: "user" }
                            | (
                                  | {
                                        type: "person";
                                        person: { email?: string | undefined };
                                        name: string | null;
                                        avatar_url: string | null;
                                        id: string;
                                        object: "user";
                                    }
                                  | {
                                        type: "bot";
                                        bot:
                                            | { [x: string]: never }
                                            | {
                                                  owner:
                                                      | {
                                                            type: "user";
                                                            user:
                                                                | {
                                                                      type: "person";
                                                                      person: {
                                                                          email: string;
                                                                      };
                                                                      name:
                                                                          | string
                                                                          | null;
                                                                      avatar_url:
                                                                          | string
                                                                          | null;
                                                                      id: string;
                                                                      object: "user";
                                                                  }
                                                                | {
                                                                      id: string;
                                                                      object: "user";
                                                                  };
                                                        }
                                                      | {
                                                            type: "workspace";
                                                            workspace: true;
                                                        };
                                              };
                                        name: string | null;
                                        avatar_url: string | null;
                                        id: string;
                                        object: "user";
                                    }
                              );
                    }
                  | {
                        type: "date";
                        date: {
                            start: string;
                            end: string | null;
                            time_zone:
                                | (
                                      | "Africa/Abidjan"
                                      | "Africa/Accra"
                                      | "Africa/Addis_Ababa"
                                      | "Africa/Algiers"
                                      | "Africa/Asmara"
                                      | "Africa/Asmera"
                                      | "Africa/Bamako"
                                      | "Africa/Bangui"
                                      | "Africa/Banjul"
                                      | "Africa/Bissau"
                                      | "Africa/Blantyre"
                                      | "Africa/Brazzaville"
                                      | "Africa/Bujumbura"
                                      | "Africa/Cairo"
                                      | "Africa/Casablanca"
                                      | "Africa/Ceuta"
                                      | "Africa/Conakry"
                                      | "Africa/Dakar"
                                      | "Africa/Dar_es_Salaam"
                                      | "Africa/Djibouti"
                                      | "Africa/Douala"
                                      | "Africa/El_Aaiun"
                                      | "Africa/Freetown"
                                      | "Africa/Gaborone"
                                      | "Africa/Harare"
                                      | "Africa/Johannesburg"
                                      | "Africa/Juba"
                                      | "Africa/Kampala"
                                      | "Africa/Khartoum"
                                      | "Africa/Kigali"
                                      | "Africa/Kinshasa"
                                      | "Africa/Lagos"
                                      | "Africa/Libreville"
                                      | "Africa/Lome"
                                      | "Africa/Luanda"
                                      | "Africa/Lubumbashi"
                                      | "Africa/Lusaka"
                                      | "Africa/Malabo"
                                      | "Africa/Maputo"
                                      | "Africa/Maseru"
                                      | "Africa/Mbabane"
                                      | "Africa/Mogadishu"
                                      | "Africa/Monrovia"
                                      | "Africa/Nairobi"
                                      | "Africa/Ndjamena"
                                      | "Africa/Niamey"
                                      | "Africa/Nouakchott"
                                      | "Africa/Ouagadougou"
                                      | "Africa/Porto-Novo"
                                      | "Africa/Sao_Tome"
                                      | "Africa/Timbuktu"
                                      | "Africa/Tripoli"
                                      | "Africa/Tunis"
                                      | "Africa/Windhoek"
                                      | "America/Adak"
                                      | "America/Anchorage"
                                      | "America/Anguilla"
                                      | "America/Antigua"
                                      | "America/Araguaina"
                                      | "America/Argentina/Buenos_Aires"
                                      | "America/Argentina/Catamarca"
                                      | "America/Argentina/ComodRivadavia"
                                      | "America/Argentina/Cordoba"
                                      | "America/Argentina/Jujuy"
                                      | "America/Argentina/La_Rioja"
                                      | "America/Argentina/Mendoza"
                                      | "America/Argentina/Rio_Gallegos"
                                      | "America/Argentina/Salta"
                                      | "America/Argentina/San_Juan"
                                      | "America/Argentina/San_Luis"
                                      | "America/Argentina/Tucuman"
                                      | "America/Argentina/Ushuaia"
                                      | "America/Aruba"
                                      | "America/Asuncion"
                                      | "America/Atikokan"
                                      | "America/Atka"
                                      | "America/Bahia"
                                      | "America/Bahia_Banderas"
                                      | "America/Barbados"
                                      | "America/Belem"
                                      | "America/Belize"
                                      | "America/Blanc-Sablon"
                                      | "America/Boa_Vista"
                                      | "America/Bogota"
                                      | "America/Boise"
                                      | "America/Buenos_Aires"
                                      | "America/Cambridge_Bay"
                                      | "America/Campo_Grande"
                                      | "America/Cancun"
                                      | "America/Caracas"
                                      | "America/Catamarca"
                                      | "America/Cayenne"
                                      | "America/Cayman"
                                      | "America/Chicago"
                                      | "America/Chihuahua"
                                      | "America/Coral_Harbour"
                                      | "America/Cordoba"
                                      | "America/Costa_Rica"
                                      | "America/Creston"
                                      | "America/Cuiaba"
                                      | "America/Curacao"
                                      | "America/Danmarkshavn"
                                      | "America/Dawson"
                                      | "America/Dawson_Creek"
                                      | "America/Denver"
                                      | "America/Detroit"
                                      | "America/Dominica"
                                      | "America/Edmonton"
                                      | "America/Eirunepe"
                                      | "America/El_Salvador"
                                      | "America/Ensenada"
                                      | "America/Fort_Nelson"
                                      | "America/Fort_Wayne"
                                      | "America/Fortaleza"
                                      | "America/Glace_Bay"
                                      | "America/Godthab"
                                      | "America/Goose_Bay"
                                      | "America/Grand_Turk"
                                      | "America/Grenada"
                                      | "America/Guadeloupe"
                                      | "America/Guatemala"
                                      | "America/Guayaquil"
                                      | "America/Guyana"
                                      | "America/Halifax"
                                      | "America/Havana"
                                      | "America/Hermosillo"
                                      | "America/Indiana/Indianapolis"
                                      | "America/Indiana/Knox"
                                      | "America/Indiana/Marengo"
                                      | "America/Indiana/Petersburg"
                                      | "America/Indiana/Tell_City"
                                      | "America/Indiana/Vevay"
                                      | "America/Indiana/Vincennes"
                                      | "America/Indiana/Winamac"
                                      | "America/Indianapolis"
                                      | "America/Inuvik"
                                      | "America/Iqaluit"
                                      | "America/Jamaica"
                                      | "America/Jujuy"
                                      | "America/Juneau"
                                      | "America/Kentucky/Louisville"
                                      | "America/Kentucky/Monticello"
                                      | "America/Knox_IN"
                                      | "America/Kralendijk"
                                      | "America/La_Paz"
                                      | "America/Lima"
                                      | "America/Los_Angeles"
                                      | "America/Louisville"
                                      | "America/Lower_Princes"
                                      | "America/Maceio"
                                      | "America/Managua"
                                      | "America/Manaus"
                                      | "America/Marigot"
                                      | "America/Martinique"
                                      | "America/Matamoros"
                                      | "America/Mazatlan"
                                      | "America/Mendoza"
                                      | "America/Menominee"
                                      | "America/Merida"
                                      | "America/Metlakatla"
                                      | "America/Mexico_City"
                                      | "America/Miquelon"
                                      | "America/Moncton"
                                      | "America/Monterrey"
                                      | "America/Montevideo"
                                      | "America/Montreal"
                                      | "America/Montserrat"
                                      | "America/Nassau"
                                      | "America/New_York"
                                      | "America/Nipigon"
                                      | "America/Nome"
                                      | "America/Noronha"
                                      | "America/North_Dakota/Beulah"
                                      | "America/North_Dakota/Center"
                                      | "America/North_Dakota/New_Salem"
                                      | "America/Ojinaga"
                                      | "America/Panama"
                                      | "America/Pangnirtung"
                                      | "America/Paramaribo"
                                      | "America/Phoenix"
                                      | "America/Port-au-Prince"
                                      | "America/Port_of_Spain"
                                      | "America/Porto_Acre"
                                      | "America/Porto_Velho"
                                      | "America/Puerto_Rico"
                                      | "America/Punta_Arenas"
                                      | "America/Rainy_River"
                                      | "America/Rankin_Inlet"
                                      | "America/Recife"
                                      | "America/Regina"
                                      | "America/Resolute"
                                      | "America/Rio_Branco"
                                      | "America/Rosario"
                                      | "America/Santa_Isabel"
                                      | "America/Santarem"
                                      | "America/Santiago"
                                      | "America/Santo_Domingo"
                                      | "America/Sao_Paulo"
                                      | "America/Scoresbysund"
                                      | "America/Shiprock"
                                      | "America/Sitka"
                                      | "America/St_Barthelemy"
                                      | "America/St_Johns"
                                      | "America/St_Kitts"
                                      | "America/St_Lucia"
                                      | "America/St_Thomas"
                                      | "America/St_Vincent"
                                      | "America/Swift_Current"
                                      | "America/Tegucigalpa"
                                      | "America/Thule"
                                      | "America/Thunder_Bay"
                                      | "America/Tijuana"
                                      | "America/Toronto"
                                      | "America/Tortola"
                                      | "America/Vancouver"
                                      | "America/Virgin"
                                      | "America/Whitehorse"
                                      | "America/Winnipeg"
                                      | "America/Yakutat"
                                      | "America/Yellowknife"
                                      | "Antarctica/Casey"
                                      | "Antarctica/Davis"
                                      | "Antarctica/DumontDUrville"
                                      | "Antarctica/Macquarie"
                                      | "Antarctica/Mawson"
                                      | "Antarctica/McMurdo"
                                      | "Antarctica/Palmer"
                                      | "Antarctica/Rothera"
                                      | "Antarctica/South_Pole"
                                      | "Antarctica/Syowa"
                                      | "Antarctica/Troll"
                                      | "Antarctica/Vostok"
                                      | "Arctic/Longyearbyen"
                                      | "Asia/Aden"
                                      | "Asia/Almaty"
                                      | "Asia/Amman"
                                      | "Asia/Anadyr"
                                      | "Asia/Aqtau"
                                      | "Asia/Aqtobe"
                                      | "Asia/Ashgabat"
                                      | "Asia/Ashkhabad"
                                      | "Asia/Atyrau"
                                      | "Asia/Baghdad"
                                      | "Asia/Bahrain"
                                      | "Asia/Baku"
                                      | "Asia/Bangkok"
                                      | "Asia/Barnaul"
                                      | "Asia/Beirut"
                                      | "Asia/Bishkek"
                                      | "Asia/Brunei"
                                      | "Asia/Calcutta"
                                      | "Asia/Chita"
                                      | "Asia/Choibalsan"
                                      | "Asia/Chongqing"
                                      | "Asia/Chungking"
                                      | "Asia/Colombo"
                                      | "Asia/Dacca"
                                      | "Asia/Damascus"
                                      | "Asia/Dhaka"
                                      | "Asia/Dili"
                                      | "Asia/Dubai"
                                      | "Asia/Dushanbe"
                                      | "Asia/Famagusta"
                                      | "Asia/Gaza"
                                      | "Asia/Harbin"
                                      | "Asia/Hebron"
                                      | "Asia/Ho_Chi_Minh"
                                      | "Asia/Hong_Kong"
                                      | "Asia/Hovd"
                                      | "Asia/Irkutsk"
                                      | "Asia/Istanbul"
                                      | "Asia/Jakarta"
                                      | "Asia/Jayapura"
                                      | "Asia/Jerusalem"
                                      | "Asia/Kabul"
                                      | "Asia/Kamchatka"
                                      | "Asia/Karachi"
                                      | "Asia/Kashgar"
                                      | "Asia/Kathmandu"
                                      | "Asia/Katmandu"
                                      | "Asia/Khandyga"
                                      | "Asia/Kolkata"
                                      | "Asia/Krasnoyarsk"
                                      | "Asia/Kuala_Lumpur"
                                      | "Asia/Kuching"
                                      | "Asia/Kuwait"
                                      | "Asia/Macao"
                                      | "Asia/Macau"
                                      | "Asia/Magadan"
                                      | "Asia/Makassar"
                                      | "Asia/Manila"
                                      | "Asia/Muscat"
                                      | "Asia/Nicosia"
                                      | "Asia/Novokuznetsk"
                                      | "Asia/Novosibirsk"
                                      | "Asia/Omsk"
                                      | "Asia/Oral"
                                      | "Asia/Phnom_Penh"
                                      | "Asia/Pontianak"
                                      | "Asia/Pyongyang"
                                      | "Asia/Qatar"
                                      | "Asia/Qostanay"
                                      | "Asia/Qyzylorda"
                                      | "Asia/Rangoon"
                                      | "Asia/Riyadh"
                                      | "Asia/Saigon"
                                      | "Asia/Sakhalin"
                                      | "Asia/Samarkand"
                                      | "Asia/Seoul"
                                      | "Asia/Shanghai"
                                      | "Asia/Singapore"
                                      | "Asia/Srednekolymsk"
                                      | "Asia/Taipei"
                                      | "Asia/Tashkent"
                                      | "Asia/Tbilisi"
                                      | "Asia/Tehran"
                                      | "Asia/Tel_Aviv"
                                      | "Asia/Thimbu"
                                      | "Asia/Thimphu"
                                      | "Asia/Tokyo"
                                      | "Asia/Tomsk"
                                      | "Asia/Ujung_Pandang"
                                      | "Asia/Ulaanbaatar"
                                      | "Asia/Ulan_Bator"
                                      | "Asia/Urumqi"
                                      | "Asia/Ust-Nera"
                                      | "Asia/Vientiane"
                                      | "Asia/Vladivostok"
                                      | "Asia/Yakutsk"
                                      | "Asia/Yangon"
                                      | "Asia/Yekaterinburg"
                                      | "Asia/Yerevan"
                                      | "Atlantic/Azores"
                                      | "Atlantic/Bermuda"
                                      | "Atlantic/Canary"
                                      | "Atlantic/Cape_Verde"
                                      | "Atlantic/Faeroe"
                                      | "Atlantic/Faroe"
                                      | "Atlantic/Jan_Mayen"
                                      | "Atlantic/Madeira"
                                      | "Atlantic/Reykjavik"
                                      | "Atlantic/South_Georgia"
                                      | "Atlantic/St_Helena"
                                      | "Atlantic/Stanley"
                                      | "Australia/ACT"
                                      | "Australia/Adelaide"
                                      | "Australia/Brisbane"
                                      | "Australia/Broken_Hill"
                                      | "Australia/Canberra"
                                      | "Australia/Currie"
                                      | "Australia/Darwin"
                                      | "Australia/Eucla"
                                      | "Australia/Hobart"
                                      | "Australia/LHI"
                                      | "Australia/Lindeman"
                                      | "Australia/Lord_Howe"
                                      | "Australia/Melbourne"
                                      | "Australia/NSW"
                                      | "Australia/North"
                                      | "Australia/Perth"
                                      | "Australia/Queensland"
                                      | "Australia/South"
                                      | "Australia/Sydney"
                                      | "Australia/Tasmania"
                                      | "Australia/Victoria"
                                      | "Australia/West"
                                      | "Australia/Yancowinna"
                                      | "Brazil/Acre"
                                      | "Brazil/DeNoronha"
                                      | "Brazil/East"
                                      | "Brazil/West"
                                      | "CET"
                                      | "CST6CDT"
                                      | "Canada/Atlantic"
                                      | "Canada/Central"
                                      | "Canada/Eastern"
                                      | "Canada/Mountain"
                                      | "Canada/Newfoundland"
                                      | "Canada/Pacific"
                                      | "Canada/Saskatchewan"
                                      | "Canada/Yukon"
                                      | "Chile/Continental"
                                      | "Chile/EasterIsland"
                                      | "Cuba"
                                      | "EET"
                                      | "EST"
                                      | "EST5EDT"
                                      | "Egypt"
                                      | "Eire"
                                      | "Etc/GMT"
                                      | "Etc/GMT+0"
                                      | "Etc/GMT+1"
                                      | "Etc/GMT+10"
                                      | "Etc/GMT+11"
                                      | "Etc/GMT+12"
                                      | "Etc/GMT+2"
                                      | "Etc/GMT+3"
                                      | "Etc/GMT+4"
                                      | "Etc/GMT+5"
                                      | "Etc/GMT+6"
                                      | "Etc/GMT+7"
                                      | "Etc/GMT+8"
                                      | "Etc/GMT+9"
                                      | "Etc/GMT-0"
                                      | "Etc/GMT-1"
                                      | "Etc/GMT-10"
                                      | "Etc/GMT-11"
                                      | "Etc/GMT-12"
                                      | "Etc/GMT-13"
                                      | "Etc/GMT-14"
                                      | "Etc/GMT-2"
                                      | "Etc/GMT-3"
                                      | "Etc/GMT-4"
                                      | "Etc/GMT-5"
                                      | "Etc/GMT-6"
                                      | "Etc/GMT-7"
                                      | "Etc/GMT-8"
                                      | "Etc/GMT-9"
                                      | "Etc/GMT0"
                                      | "Etc/Greenwich"
                                      | "Etc/UCT"
                                      | "Etc/UTC"
                                      | "Etc/Universal"
                                      | "Etc/Zulu"
                                      | "Europe/Amsterdam"
                                      | "Europe/Andorra"
                                      | "Europe/Astrakhan"
                                      | "Europe/Athens"
                                      | "Europe/Belfast"
                                      | "Europe/Belgrade"
                                      | "Europe/Berlin"
                                      | "Europe/Bratislava"
                                      | "Europe/Brussels"
                                      | "Europe/Bucharest"
                                      | "Europe/Budapest"
                                      | "Europe/Busingen"
                                      | "Europe/Chisinau"
                                      | "Europe/Copenhagen"
                                      | "Europe/Dublin"
                                      | "Europe/Gibraltar"
                                      | "Europe/Guernsey"
                                      | "Europe/Helsinki"
                                      | "Europe/Isle_of_Man"
                                      | "Europe/Istanbul"
                                      | "Europe/Jersey"
                                      | "Europe/Kaliningrad"
                                      | "Europe/Kiev"
                                      | "Europe/Kirov"
                                      | "Europe/Lisbon"
                                      | "Europe/Ljubljana"
                                      | "Europe/London"
                                      | "Europe/Luxembourg"
                                      | "Europe/Madrid"
                                      | "Europe/Malta"
                                      | "Europe/Mariehamn"
                                      | "Europe/Minsk"
                                      | "Europe/Monaco"
                                      | "Europe/Moscow"
                                      | "Europe/Nicosia"
                                      | "Europe/Oslo"
                                      | "Europe/Paris"
                                      | "Europe/Podgorica"
                                      | "Europe/Prague"
                                      | "Europe/Riga"
                                      | "Europe/Rome"
                                      | "Europe/Samara"
                                      | "Europe/San_Marino"
                                      | "Europe/Sarajevo"
                                      | "Europe/Saratov"
                                      | "Europe/Simferopol"
                                      | "Europe/Skopje"
                                      | "Europe/Sofia"
                                      | "Europe/Stockholm"
                                      | "Europe/Tallinn"
                                      | "Europe/Tirane"
                                      | "Europe/Tiraspol"
                                      | "Europe/Ulyanovsk"
                                      | "Europe/Uzhgorod"
                                      | "Europe/Vaduz"
                                      | "Europe/Vatican"
                                      | "Europe/Vienna"
                                      | "Europe/Vilnius"
                                      | "Europe/Volgograd"
                                      | "Europe/Warsaw"
                                      | "Europe/Zagreb"
                                      | "Europe/Zaporozhye"
                                      | "Europe/Zurich"
                                      | "GB"
                                      | "GB-Eire"
                                      | "GMT"
                                      | "GMT+0"
                                      | "GMT-0"
                                      | "GMT0"
                                      | "Greenwich"
                                      | "HST"
                                      | "Hongkong"
                                      | "Iceland"
                                      | "Indian/Antananarivo"
                                      | "Indian/Chagos"
                                      | "Indian/Christmas"
                                      | "Indian/Cocos"
                                      | "Indian/Comoro"
                                      | "Indian/Kerguelen"
                                      | "Indian/Mahe"
                                      | "Indian/Maldives"
                                      | "Indian/Mauritius"
                                      | "Indian/Mayotte"
                                      | "Indian/Reunion"
                                      | "Iran"
                                      | "Israel"
                                      | "Jamaica"
                                      | "Japan"
                                      | "Kwajalein"
                                      | "Libya"
                                      | "MET"
                                      | "MST"
                                      | "MST7MDT"
                                      | "Mexico/BajaNorte"
                                      | "Mexico/BajaSur"
                                      | "Mexico/General"
                                      | "NZ"
                                      | "NZ-CHAT"
                                      | "Navajo"
                                      | "PRC"
                                      | "PST8PDT"
                                      | "Pacific/Apia"
                                      | "Pacific/Auckland"
                                      | "Pacific/Bougainville"
                                      | "Pacific/Chatham"
                                      | "Pacific/Chuuk"
                                      | "Pacific/Easter"
                                      | "Pacific/Efate"
                                      | "Pacific/Enderbury"
                                      | "Pacific/Fakaofo"
                                      | "Pacific/Fiji"
                                      | "Pacific/Funafuti"
                                      | "Pacific/Galapagos"
                                      | "Pacific/Gambier"
                                      | "Pacific/Guadalcanal"
                                      | "Pacific/Guam"
                                      | "Pacific/Honolulu"
                                      | "Pacific/Johnston"
                                      | "Pacific/Kiritimati"
                                      | "Pacific/Kosrae"
                                      | "Pacific/Kwajalein"
                                      | "Pacific/Majuro"
                                      | "Pacific/Marquesas"
                                      | "Pacific/Midway"
                                      | "Pacific/Nauru"
                                      | "Pacific/Niue"
                                      | "Pacific/Norfolk"
                                      | "Pacific/Noumea"
                                      | "Pacific/Pago_Pago"
                                      | "Pacific/Palau"
                                      | "Pacific/Pitcairn"
                                      | "Pacific/Pohnpei"
                                      | "Pacific/Ponape"
                                      | "Pacific/Port_Moresby"
                                      | "Pacific/Rarotonga"
                                      | "Pacific/Saipan"
                                      | "Pacific/Samoa"
                                      | "Pacific/Tahiti"
                                      | "Pacific/Tarawa"
                                      | "Pacific/Tongatapu"
                                      | "Pacific/Truk"
                                      | "Pacific/Wake"
                                      | "Pacific/Wallis"
                                      | "Pacific/Yap"
                                      | "Poland"
                                      | "Portugal"
                                      | "ROC"
                                      | "ROK"
                                      | "Singapore"
                                      | "Turkey"
                                      | "UCT"
                                      | "US/Alaska"
                                      | "US/Aleutian"
                                      | "US/Arizona"
                                      | "US/Central"
                                      | "US/East-Indiana"
                                      | "US/Eastern"
                                      | "US/Hawaii"
                                      | "US/Indiana-Starke"
                                      | "US/Michigan"
                                      | "US/Mountain"
                                      | "US/Pacific"
                                      | "US/Pacific-New"
                                      | "US/Samoa"
                                      | "UTC"
                                      | "Universal"
                                      | "W-SU"
                                      | "WET"
                                      | "Zulu"
                                  )
                                | null;
                        };
                    }
                  | { type: "link_preview"; link_preview: { url: string } }
                  | {
                        type: "template_mention";
                        template_mention:
                            | {
                                  type: "template_mention_date";
                                  template_mention_date: "today" | "now";
                              }
                            | {
                                  type: "template_mention_user";
                                  template_mention_user: "me";
                              };
                    }
                  | { type: "page"; page: { id: string } }
                  | { type: "database"; database: { id: string } };
              annotations: {
                  bold: boolean;
                  italic: boolean;
                  strikethrough: boolean;
                  underline: boolean;
                  code: boolean;
                  color:
                      | "default"
                      | "gray"
                      | "brown"
                      | "orange"
                      | "yellow"
                      | "green"
                      | "blue"
                      | "purple"
                      | "pink"
                      | "red"
                      | "gray_background"
                      | "brown_background"
                      | "orange_background"
                      | "yellow_background"
                      | "green_background"
                      | "blue_background"
                      | "purple_background"
                      | "pink_background"
                      | "red_background";
              };
              plain_text: string;
              href: string | null;
          }
        | {
              type: "equation";
              equation: { expression: string };
              annotations: {
                  bold: boolean;
                  italic: boolean;
                  strikethrough: boolean;
                  underline: boolean;
                  code: boolean;
                  color:
                  
                      | "default"
                      | "gray"
                      | "brown"
                      | "orange"
                      | "yellow"
                      | "green"
                      | "blue"
                      | "purple"
                      | "pink"
                      | "red"
                      | "gray_background"
                      | "brown_background"
                      | "orange_background"
                      | "yellow_background"
                      | "green_background"
                      | "blue_background"
                      | "purple_background"
                      | "pink_background"
                      | "red_background";
              };
              plain_text: string;
              href: string | null;
          }
    )[]
 */
