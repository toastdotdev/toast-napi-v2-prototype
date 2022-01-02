// import { sourceMdx } from "@toastdotdev/mdx";
import { compile } from "@mdx-js/mdx";
import { promises as fs } from "fs";
import globby from "globby";
import path from "path";
import { visit } from "unist-util-visit";

export const sourceData = async ({ setDataForSlug }) => {
  await sourceMdx({
    setDataForSlug,
    directory: "./content",
    slugPrefix: "/",
  });
  return;
};

const sourceMdx = async ({
  setDataForSlug,
  namedExports = ["meta"],
  directory = [],
  sources = [],
  slugPrefix = "/",
  ...options
}) => {
  let files = [];

  // given a directory or list of directories,
  // fetch the mdx
  if (directory) {
    let dirs = [];
    if (Array.isArray(directory)) {
      dirs = directory;
    } else if (typeof directory === "string") {
      dirs = [directory];
    } else {
      throw new Error(
        `directory should be a string or an array of strings, received: ${directory}`
      );
    }
    const results = await Promise.all(
      dirs.map((dir) => fetchMdxFromDisk({ directory: dir }))
    );
    files = results.flat();
  }
  // if we're given MDX strings, make them into
  // a form we can process
  if (sources) {
    files = files.concat(sources);
  }
  return Promise.all(
    files.map(async ({ filename, file, source, id }) => {
      let result;
      try {
        result = await processMdx(file || source, {
          filepath: filename,
          namedExports,
        });
      } catch (e) {
        let matchString = "";
        try {
          // get the line and column from the error, if it exists
          let match = e.toString().match(/\((\d+):\d+-(\d+):\d+\)$/);
          if (match) {
            let lowerBound = parseInt(match[1]) - 3 || 0;
            let upperBound = parseInt(match[2]) + 3;
            matchString = `

\`\`\`
${(file || source)
  .split("\n")
  .filter((line, i) => {
    // if line is within bounds, keep it
    return i >= lowerBound && i <= upperBound;
  })
  .map(
    (line, i) =>
      `${(lowerBound + i)
        .toString()
        .padStart(upperBound.toString().length, " ")} |${line}`
  )
  .join("\n")}
\`\`\``;
          }
        } catch (e) {
          // swallow any match creation errors
          // because they won't enable the user to *do* anything
        }
        const error = new Error(`Mdx ${
          source ? `source: \`${id}\`` : `file: \`${filename}\``
        } had an error while processing in \`@toastdotdev/mdx\`:

    ${e}${matchString}`);
        // We don't want the error showing up as being from here
        // it's from the Mdx parsing, which the newly created
        // stack we just created doesn't represent
        error.stack = "";
        throw error;
      }
      const compiledMdx = result.content;
      const mdxExports = result.data.exports;
      // if the user doesn't have a meta export, make it
      // an empty object
      if (!mdxExports.meta) {
        mdxExports.meta = {};
      }
      // if user hasn't specified a slug, but has a title
      // slugify the title
      if (!mdxExports.meta.slug && mdxExports.meta.title) {
        mdxExports.meta.slug = slugify(mdxExports.meta.title);
      }
      // if we still don't have a slug, use the filename
      if (!mdxExports.meta.slug && filename) {
        // TODO: doesn't account for `directory/index.mdx` yet
        mdxExports.meta.slug = slugify(
          path.basename(filename, path.extname(filename))
        );
      }
      if (!mdxExports.meta.slug) {
        throw new Error(`unable to generate slug. The following MDX does not have a \`slug\` or \`title\` in \`export const meta\` and also does not have a filename:

${file}`);
      }

      // remove leading and trailing slashes
      mdxExports.meta.slug = mdxExports.meta.slug
        .replace(/^\//, "")
        .replace(/\/$/, "");

      let prefix = slugPrefix === "/" ? "/" : slugPrefix + "/";
      await setDataForSlug(prefix + mdxExports.meta.slug, {
        component: {
          mode: "source",
          value: compiledMdx,
        },
        data: mdxExports,
      });

      return mdxExports;
    })
  );
};

const fetchMdxFromDisk = async ({ directory, extensions = ["mdx"] }) => {
  const filenames = await globby(directory, {
    expandDirectories: { extensions },
  });
  const files = await Promise.all(
    filenames.map(async (filename) => {
      const contents = await fs.readFile(filename, "utf-8");
      return {
        filename,
        file: contents,
      };
    })
  );

  return files;
};

//

// a remark plugin that plucks MDX exports and converts
// the raw estree representation of exports to JSON as much
// as possible
function remarkPluckMeta({ exportNames }) {
  return (tree, file) => {
    file.data.exports = {};

    visit(tree, "mdxjsEsm", (ast) => {
      const exportNodes = ast?.data?.estree?.body
        .filter((child) => child.type === "ExportNamedDeclaration")
        .forEach((exportDecl) => {
          // declarations is technically an array because you
          // can do things like `let x,y,z;` but that really
          // doesn't apply for this use case
          const decl = exportDecl.declaration.declarations[0];
          // if we should handle this
          if (exportNames.includes(decl.id.name)) {
            file.data.exports[decl.id.name] = handleDecl(
              decl.init,
              decl.id.name
            );
          }
        });
    });

    return tree;
  };
}

function handleDecl(decl, parent) {
  // handle value
  let pluckedValue;
  switch (decl.type) {
    case "Literal":
      pluckedValue = decl.value;
      break;
    case "ObjectExpression":
      const fields = Object.fromEntries(
        decl.properties.map(({ key, value, kind }) => {
          // kind can be "init", "get", or "set"
          if (kind === "init") {
            // handle key name
            let keyName;
            switch (key.type) {
              case "Identifier":
                keyName = key.name;
                break;
              case "Literal":
                keyName = key.value;
                break;
              default:
                console.warn(
                  `toast-tools/mdx: Unhandleable property type ${key.type} in ${parent}. If you think this should be handled, please file a bug.`
                );
            }
            return [keyName, handleDecl(value, `${parent}.${keyName}`)];
          } else {
            console.warn(
              `toast-tools.rehype-pluck-meta is not going to handle object property with kind \`${kind}\` on export ${parent}`
            );
          }
        })
      );
      pluckedValue = fields;
      break;
    case "ArrayExpression":
      pluckedValue = decl.elements.map((elementDecl, i) =>
        handleDecl(elementDecl, `parent[${i}]`)
      );
      break;
    case "TemplateLiteral":
      if (decl.expressions.length !== 0) {
        console.warn(
          `[skipping] @toast-tools/mdx: Template Literals with expressions are not handled. at ${parent}`
        );
        break;
      }
      // TODO: should we remove newlines from this?
      pluckedValue = decl.quasis[0].value.raw;
      break;
    default:
      console.warn(
        `Unhandleable value type ${decl.type} in ${parent}. If you think this should be handled, please file a bug.`
      );
  }

  return pluckedValue;
}

export const processMdx = async (
  content,
  {
    filepath,
    namedExports = [],
    prismTheme,
    remarkPlugins = [],
    rehypePlugins = [],
  }
) => {
  return compileMdx(content, {
    filepath,
    remarkPlugins: [
      [
        remarkPluckMeta,
        {
          exportNames: namedExports.includes("meta")
            ? namedExports
            : [...namedExports, "meta"],
        },
      ],
      ...remarkPlugins,
    ],
    rehypePlugins: [
      // [rehypePrism, { theme: prismTheme }],
      // rehypeSlug,
      // [
      //   rehypeLink,
      //   {
      //     properties: {
      //       className: "heading-link-anchor",
      //       // style: "position: absolute; right: calc(100% + 5px);",
      //     },
      //     content: {
      //       type: "element",
      //       tagName: "heading-link-icon",
      //       properties: { className: ["heading-link-icon"] },
      //       children: [],
      //       // children: [parsedCorgi]
      //     },
      //   },
      // ],
      ...rehypePlugins,
    ],
  });
};

// process MDX using a slightly custom function
// so that we get the data back from plugins
// you should probably use processMdx
export async function compileMdx(mdx, options = {}) {
  // const compiler = createCompiler(options);

  const { filepath, ...newOptions } = options;
  const fileOpts = { value: mdx };
  if (options.filepath) {
    fileOpts.path = options.filepath;
  }

  // {path: 'path/to/file.mdx', value: '🥳'}
  // let x = await compile(mdx, options);

  const { value, data } = await compile(fileOpts, newOptions);

  return {
    content: `${value}`,
    data,
  };
}
