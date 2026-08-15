import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";

import { tmpdir } from "node:os";

import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import { spawnSync } from "node:child_process";


const root =
  process.cwd();

const ignoredDirectories =
  new Set([
    ".git",
    "node_modules"
  ]);

const errors = [];


async function walk(directory) {

  const entries =
    await readdir(
      directory,
      {
        withFileTypes: true
      }
    );

  const files = [];


  for (const entry of entries) {

    if (
      entry.name.startsWith(".") &&
      entry.name !== ".well-known"
    ) {
      continue;
    }


    const path =
      join(
        directory,
        entry.name
      );


    if (
      entry.isDirectory() &&
      !ignoredDirectories.has(
        entry.name
      )
    ) {

      files.push(
        ...await walk(path)
      );

    } else if (
      entry.isFile() &&
      extname(
        entry.name
      ).toLowerCase() === ".html"
    ) {

      files.push(path);
    }
  }


  return files;
}


async function exists(path) {

  try {

    await access(path);

    return true;

  } catch {

    return false;
  }
}


function displayPath(path) {

  return relative(
    root,
    path
  )
    .split(sep)
    .join("/");
}


function lineNumber(
  source,
  index
) {

  return source
    .slice(
      0,
      index
    )
    .split("\n")
    .length;
}


function isExternalReference(value) {

  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i
    .test(value);
}


function extractIds(source) {

  const ids =
    new Set();


  for (
    const match of source.matchAll(
      /\bid\s*=\s*(["'])(.*?)\1/gi
    )
  ) {

    if (
      ids.has(
        match[2]
      )
    ) {

      errors.push(
        `duplicate id "${match[2]}"`
      );
    }


    ids.add(
      match[2]
    );
  }
}


async function resolveLocalTarget(
  sourceFile,
  rawValue
) {

  const decoded =
    decodeURIComponent(
      rawValue.replace(
        /&amp;/gi,
        "&"
      )
    );


  const [
    withoutHash,
    fragment = ""
  ] =
    decoded.split(
      "#",
      2
    );


  const pathPart =
    withoutHash
      .split(
        "?",
        1
      )[0];


  if (!pathPart) {

    return {
      target: sourceFile,
      fragment
    };
  }


  let target =
    pathPart.startsWith("/")
      ? resolve(
          root,
          `.${pathPart}`
        )
      : resolve(
          dirname(sourceFile),
          pathPart
        );


  if (
    !target.startsWith(
      `${root}${sep}`
    ) &&
    target !== root
  ) {

    throw new Error(
      "reference escapes the repository"
    );
  }


  if (
    pathPart.endsWith("/")
  ) {

    target =
      join(
        target,
        "index.html"
      );
  }


  return {
    target,
    fragment
  };
}


async function validateReferences(
  file,
  source,
  htmlByPath
) {

  const attributePattern =
    /\b(?:href|src|action|poster)\s*=\s*(["'])(.*?)\1/gi;


  for (
    const match of source.matchAll(
      attributePattern
    )
  ) {

    const value =
      match[2].trim();


    if (
      !value ||
      isExternalReference(value)
    ) {
      continue;
    }


    try {

      const {
        target,
        fragment
      } =
        await resolveLocalTarget(
          file,
          value
        );


      if (
        !await exists(target)
      ) {

        errors.push(
          `${displayPath(file)}:${lineNumber(source, match.index)} missing local target "${value}"`
        );

        continue;
      }


      if (
        fragment &&
        extname(
          target
        ).toLowerCase() === ".html"
      ) {

        const targetSource =
          htmlByPath.get(target) ??
          await readFile(
            target,
            "utf8"
          );


        const targetIds =
          new Set(
            [
              ...targetSource.matchAll(
                /\bid\s*=\s*(["'])(.*?)\1/gi
              )
            ].map(
              item => item[2]
            )
          );


        if (
          !targetIds.has(
            fragment
          )
        ) {

          errors.push(
            `${displayPath(file)}:${lineNumber(source, match.index)} missing anchor "#${fragment}" in ${displayPath(target)}`
          );
        }
      }

    } catch (error) {

      errors.push(
        `${displayPath(file)}:${lineNumber(source, match.index)} invalid reference "${value}": ${error.message}`
      );
    }
  }
}


async function validateInlineScripts(
  file,
  source,
  temporaryDirectory
) {

  const scriptPattern =
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

  let scriptNumber = 0;


  for (
    const match of source.matchAll(
      scriptPattern
    )
  ) {

    const attributes =
      match[1];

    const script =
      match[2].trim();


    if (
      !script ||
      /\bsrc\s*=/i.test(
        attributes
      )
    ) {
      continue;
    }


    const type =
      attributes.match(
        /\btype\s*=\s*(["'])(.*?)\1/i
      )?.[2]?.toLowerCase();


    const isModule =
      type === "module";


    const isJavaScript =
      !type ||
      isModule ||
      /^(?:text|application)\/(?:java|ecma)script$/
        .test(type);


    if (!isJavaScript) {
      continue;
    }


    scriptNumber += 1;


    const extension =
      isModule
        ? "mjs"
        : "cjs";


    const temporaryFile =
      join(
        temporaryDirectory,
        `${scriptNumber}.${extension}`
      );


    await writeFile(
      temporaryFile,
      script
    );


    const result =
      spawnSync(
        process.execPath,
        [
          "--check",
          temporaryFile
        ],
        {
          encoding: "utf8"
        }
      );


    if (
      result.status !== 0
    ) {

      const message =
        (
          result.stderr ||
          result.stdout
        )
          .trim()
          .split("\n")
          .slice(-3)
          .join(" ");


      errors.push(
        `${displayPath(file)} inline script ${scriptNumber} has invalid JavaScript: ${message}`
      );
    }
  }
}


const htmlFiles =
  await walk(root);


const htmlByPath =
  new Map();


for (
  const file of htmlFiles
) {

  htmlByPath.set(
    file,
    await readFile(
      file,
      "utf8"
    )
  );
}


const temporaryDirectory =
  await mkdtemp(
    join(
      tmpdir(),
      "starrise-validation-"
    )
  );


try {

  for (
    const [
      file,
      source
    ] of htmlByPath
  ) {

    const previousErrorCount =
      errors.length;


    extractIds(source);


    if (
      errors.length >
      previousErrorCount
    ) {

      const duplicates =
        errors.splice(
          previousErrorCount
        );


      errors.push(
        ...duplicates.map(
          error =>
            `${displayPath(file)} ${error}`
        )
      );
    }


    await validateReferences(
      file,
      source,
      htmlByPath
    );


    await validateInlineScripts(
      file,
      source,
      temporaryDirectory
    );
  }

} finally {

  await rm(
    temporaryDirectory,
    {
      recursive: true,
      force: true
    }
  );
}


if (
  errors.length
) {

  console.error(
    `Site validation failed with ${errors.length} problem${errors.length === 1 ? "" : "s"}:`
  );


  for (
    const error of errors
  ) {

    console.error(
      `- ${error}`
    );
  }


  process.exit(1);
}


console.log(
  `Validated ${htmlFiles.length} HTML files: local links, anchors, duplicate IDs, and inline JavaScript are clean.`
);
