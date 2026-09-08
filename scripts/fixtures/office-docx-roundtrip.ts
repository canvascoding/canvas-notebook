import JSZip from 'jszip';

export const OFFICE_ROUNDTRIP_NAMESPACES = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  types: 'http://schemas.openxmlformats.org/package/2006/content-types',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  vendor: 'urn:canvas:roundtrip:unknown',
} as const;

export const OFFICE_ROUNDTRIP_TEXT = 'Edit only this sentence.';
export const OFFICE_ROUNDTRIP_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=', 'base64');

export type OfficeRoundtripFixtureOptions = {
  comments?: boolean;
  trackedChanges?: boolean;
  unknownBody?: boolean;
  unknownParagraphProperty?: boolean;
};

/** All XML and media are local, deterministic fixtures; no generated file is checked in. */
export async function createOfficeRoundtripFixture(options: OfficeRoundtripFixtureOptions = {}): Promise<Buffer> {
  const { comments = true, trackedChanges = true, unknownBody = false, unknownParagraphProperty = false } = options;
  const ns = OFFICE_ROUNDTRIP_NAMESPACES;
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const zip = new JSZip();
  const add = (name: string, content: string | Buffer) => zip.file(name, content, { date: new Date('2026-09-08T10:00:00Z') });
  add('[Content_Types].xml', `${xml}<Types xmlns="${ns.types}">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>
    <Default Extension="bin" ContentType="application/octet-stream"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
    <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
    <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
    <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
    ${comments ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ''}
  </Types>`);
  add('_rels/.rels', `${xml}<Relationships xmlns="${ns.rels}">
    <Relationship Id="rMain" Type="${ns.r}/officeDocument" Target="word/document.xml"/>
    <Relationship Id="rCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  </Relationships>`);
  add('word/document.xml', `${xml}<w:document xmlns:w="${ns.w}" xmlns:r="${ns.r}" xmlns:wp="${ns.wp}" xmlns:a="${ns.a}" xmlns:pic="${ns.pic}"
    xmlns:w14="${ns.w14}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:vendor="${ns.vendor}" mc:Ignorable="w14 vendor">
    <w:body>
      <w:p w14:paraId="10000001"><w:pPr><w:pStyle w:val="Normal"/>${unknownParagraphProperty ? '<w:contextualSpacing/><vendor:rule vendor:id="preserve-rule"/>' : ''}</w:pPr><w:r><w:t>${OFFICE_ROUNDTRIP_TEXT}</w:t></w:r></w:p>
      <w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="8" w:color="112233"/><w:bottom w:val="single" w:sz="8" w:color="112233"/></w:tblBorders></w:tblPr>
        <w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/><w:gridSpan w:val="2"/><w:shd w:fill="DDEEFF"/></w:tcPr><w:p w14:paraId="10000002"><w:r><w:t>Merged header</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p w14:paraId="10000003"><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p w14:paraId="10000004"><w:r><w:t>42.00 EUR</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
      <w:p w14:paraId="10000005"><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/>
        <wp:docPr id="1" name="preserved-pixel.png" descr="Company logo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
        <a:graphic><a:graphicData uri="${ns.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="preserved-pixel.png"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="rImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
      <w:p w14:paraId="10000006"><w:hyperlink r:id="rExternal" w:tooltip="Company reference"><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>Reference link</w:t></w:r></w:hyperlink></w:p>
      ${comments ? '<w:p w14:paraId="10000007"><w:commentRangeStart w:id="7"/><w:r><w:t>Commented sentence</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="7"/></w:r></w:p>' : ''}
      ${trackedChanges ? '<w:p w14:paraId="10000008"><w:del w:id="11" w:author="Human reviewer" w:date="2026-09-08T09:00:00Z"><w:r><w:delText>Rejected wording</w:delText></w:r></w:del><w:ins w:id="12" w:author="Human reviewer" w:date="2026-09-08T09:01:00Z"><w:r><w:rPr><w:b/></w:rPr><w:t>Inserted wording</w:t></w:r></w:ins></w:p>' : ''}
      ${unknownBody ? '<w:customXml w:uri="urn:canvas:roundtrip:business" w:element="protected-record"><w:customXmlPr><w:attr w:name="key" w:val="record-7"/></w:customXmlPr><w:p w14:paraId="10000009"><w:r><w:t>Protected custom XML content</w:t></w:r></w:p></w:customXml><vendor:extension vendor:id="preserve-extension"><vendor:payload>Business metadata inside main document</vendor:payload></vendor:extension>' : ''}
      <w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="default" r:id="rFooter"/>
        <w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
      </w:sectPr>
    </w:body>
  </w:document>`);
  add('word/_rels/document.xml.rels', `${xml}<Relationships xmlns="${ns.rels}">
    <Relationship Id="rImage" Type="${ns.r}/image" Target="media/pixel.png"/>
    <Relationship Id="rHeader" Type="${ns.r}/header" Target="header1.xml"/>
    <Relationship Id="rFooter" Type="${ns.r}/footer" Target="footer1.xml"/>
    <Relationship Id="rStyles" Type="${ns.r}/styles" Target="styles.xml"/>
    <Relationship Id="rExternal" Type="${ns.r}/hyperlink" Target="https://example.invalid/reference?edition=1#section" TargetMode="External"/>
    <Relationship Id="rCustom" Type="${ns.r}/customXml" Target="../customXml/item1.xml"/>
    ${comments ? `<Relationship Id="rComments" Type="${ns.r}/comments" Target="comments.xml"/>` : ''}
  </Relationships>`);
  add('word/styles.xml', `${xml}<w:styles xmlns:w="${ns.w}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="character" w:styleId="CommentReference"><w:name w:val="Comment Reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style></w:styles>`);
  add('word/header1.xml', `${xml}<w:hdr xmlns:w="${ns.w}"><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Confidential header</w:t></w:r></w:p></w:hdr>`);
  add('word/footer1.xml', `${xml}<w:ftr xmlns:w="${ns.w}"><w:p><w:r><w:t>Stable footer</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`);
  if (comments) add('word/comments.xml', `${xml}<w:comments xmlns:w="${ns.w}"><w:comment w:id="7" w:author="Reviewer" w:initials="RV" w:date="2026-09-08T09:05:00Z"><w:p><w:r><w:t>Keep this review comment.</w:t></w:r></w:p></w:comment></w:comments>`);
  add('word/media/pixel.png', OFFICE_ROUNDTRIP_PNG);
  add('word/vendor/opaque.bin', Buffer.from([0, 1, 255, 80, 75, 3, 4, 9, 0, 222]));
  add('customXml/item1.xml', `${xml}<vendor:record xmlns:vendor="${ns.vendor}" vendor:key="immutable-custom-part"><vendor:data><![CDATA[Unknown <XML> & payload]]></vendor:data></vendor:record>`);
  add('docProps/core.xml', `${xml}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Office roundtrip acceptance fixture</dc:title><dc:creator>Canvas fixture</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-09-08T10:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-08T10:00:00Z</dcterms:modified></cp:coreProperties>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
