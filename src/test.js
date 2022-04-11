// Numbered lists
// The lists can also be restarted by specifying the instance number
// Import from 'docx' rather than '../build' if you install from npm
const fs = require("fs");
const {
    AlignmentType,
    convertInchesToTwip,
    Document,
    HeadingLevel,
    LevelFormat,
    Packer,
    Paragraph,
} = require("docx");

const STYLES = fs.readFileSync("./styles.xml", { encoding: "utf-8" });

Paragraph.numbering;

let a = new Paragraph();
a.numbering()

const doc = new Document({
    externalStyles: STYLES,
    numbering: {
        config: [
            {
                levels: [
                    {
                        level: 0,
                        format: LevelFormat.UPPER_ROMAN,
                        text: "%1",
                        alignment: AlignmentType.START,
                        style: "List Paragraph",
                    },
                ],
                reference: "my-crazy-reference",
            },
            {
                levels: [
                    {
                        level: 0,
                        format: LevelFormat.DECIMAL,
                        text: "%1.",
                        alignment: AlignmentType.START,
                        // style: "List Paragraph",
                        style: {
                            paragraph: {
                                indent: {
                                    left: convertInchesToTwip(0.14),
                                    hanging: convertInchesToTwip(0.25),
                                },
                            },
                            
                        },
                    },
                    {
                        level: 1,
                        format: LevelFormat.DECIMAL,
                        text: "%a.",
                        alignment: AlignmentType.START,
                        // style: "List Paragraph",
                        style: {
                            paragraph: {
                                indent: {
                                    left: convertInchesToTwip(0.64),
                                    hanging: convertInchesToTwip(0.25),
                                },
                            },
                        },
                    },
                ],

                reference: "my-number-numbering-reference",
            },
            {
                levels: [
                    {
                        level: 0,
                        format: LevelFormat.DECIMAL_ZERO,
                        text: "[%1]",
                        alignment: AlignmentType.START,
                        style: {
                            paragraph: {
                                indent: {
                                    left: convertInchesToTwip(0.5),
                                    hanging: convertInchesToTwip(0.18),
                                },
                            },
                        },
                    },
                ],
                reference: "padded-numbering-reference",
            },
        ],
    },
    sections: [
        {
            children: [
                new Paragraph({
                    text: "line with contextual spacing",
                    numbering: {
                        reference: "my-crazy-reference",
                        level: 0,
                    },
                    contextualSpacing: true,
                    spacing: {
                        before: 200,
                    },
                }),
                new Paragraph({
                    text: "line with contextual spacing",
                    numbering: {
                        reference: "my-crazy-reference",
                        level: 0,
                    },
                    contextualSpacing: true,
                    spacing: {
                        before: 200,
                    },
                }),
                new Paragraph({
                    text: "line without contextual spacing",
                    numbering: {
                        reference: "my-crazy-reference",
                        level: 0,
                    },
                    contextualSpacing: false,
                    spacing: {
                        before: 200,
                    },
                }),
                ,
                new Paragraph({
                    text: "line without contextual spacing",
                    numbering: {
                        reference: "my-crazy-reference",
                        level: 0,
                    },
                    contextualSpacing: false,
                    spacing: {
                        before: 200,
                    },
                }),
                new Paragraph({
                    text: "Step 1 - Add sugar",
                    numbering: {
                        reference: "my-number-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "Step 2 - Add wheat",
                    numbering: {
                        reference: "my-number-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "Next",
                    heading: HeadingLevel.HEADING_2,
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                        instance: 2,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                        instance: 2,
                    },
                }),
                new Paragraph({
                    text: "Next",
                    heading: HeadingLevel.HEADING_2,
                }),

                new Paragraph({
                    text: "Step 3 - Put in oven",
                    numbering: {
                        reference: "my-number-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                        instance: 1,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                        instance: 3,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                        instance: 3,
                    },
                }),
                new Paragraph({
                    text: "Next",
                    heading: HeadingLevel.HEADING_2,
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
                new Paragraph({
                    text: "test",
                    numbering: {
                        reference: "padded-numbering-reference",
                        level: 0,
                    },
                }),
            ],
        },
    ],
});

Packer.toBuffer(doc).then((buffer) => {
    fs.writeFileSync("My Document.docx", buffer);
});
