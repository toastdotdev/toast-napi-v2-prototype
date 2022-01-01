#![deny(clippy::all)]

use esinstall::ImportMap;
use futures::stream::StreamExt;
use miette::{IntoDiagnostic, WrapErr};
use sources::{Source, SourceKind};
use std::{
  collections::HashMap,
  fs,
  path::{Path, PathBuf},
};
use tokio::sync::{
  mpsc::{unbounded_channel, UnboundedSender},
  OnceCell,
};
use tokio_stream::wrappers::UnboundedReceiverStream;
use walkdir::WalkDir;

mod cache;
mod esinstall;
mod internal_api;
mod sources;
mod swc_import_map_rewrite;
mod swc_ops;

use internal_api::{Event, SetDataForSlug};

#[macro_use]
extern crate napi_derive;

const VERSION: &str = env!("CARGO_PKG_VERSION");
static ONCE: OnceCell<UnboundedSender<Event>> =
  OnceCell::const_new();

#[napi]
fn version() -> &'static str {
  VERSION
}

#[derive(Debug)]
struct OutputFile {
  dest: String,
}

#[napi]
fn done_sourcing_data() -> napi::Result<()> {
  while !ONCE.initialized() {}
  let sender = {
    let tx = ONCE.get();
    tx.clone().unwrap()
  };

  match sender.send(Event::End) {
    Ok(_) => Ok(()),
    Err(_) => Ok(()),
  }
}
#[napi]
async fn set_data_for_slug(
  user_input: String,
) -> napi::Result<()> {
  while !ONCE.initialized() {}
  let sender = {
    let tx = ONCE.get();
    tx.clone().unwrap()
  };
  let data: SetDataForSlug =
    serde_json::from_str(&user_input).unwrap();
  match sender.send(Event::Set(data)) {
    Ok(_) => Ok(()),
    Err(_) => Ok(()),
  }
}

#[napi]
async fn incremental(
  input_dir: String,
  output_dir: String,
) -> napi::Result<Vec<String>> {
  match incremental_internal(input_dir, output_dir).await {
    Ok(urls) => Ok(urls),
    Err(e) => {
      dbg!("oh no! our table! it's broken!");
      println!("{}", e);
      Ok(vec![])
    }
  }

  // Ok(vec!["testing".to_string(), "paths".to_string()])
}

async fn incremental_internal(
  input_dir: String,
  output_dir: String,
) -> miette::Result<Vec<String>> {
  let mut cache = cache::init();

  let (tx, rx) = unbounded_channel();
  let goodbye_tx = tx.clone();
  ONCE.set(goodbye_tx).unwrap();
  // Create the output directory and any intermediary directories
  // we need
  std::fs::create_dir_all(&output_dir)
    .into_diagnostic()
    .wrap_err(format!(
      "Failed create directories for path `{}`",
      &output_dir
    ))?;

  let import_map = {
    let import_map_filepath = PathBuf::from(&output_dir)
      .join("web_modules")
      .join("import-map.json");
    let contents = fs::read_to_string(&import_map_filepath)
    .into_diagnostic()
    .wrap_err(format!(
      "Failed to read `import-map.json` from `{}`

esinstall should create this directory. It looks like it either didn't run or failed to create the directory.",
      &import_map_filepath.display()
    ))?;
    esinstall::parse_import_map(&contents)
    .into_diagnostic().wrap_err(
      format!(
          "Failed to parse import map from content `{}` at `{}`",
          contents,
          &import_map_filepath.display()
      )
  )?
  };

  let tmp_dir = PathBuf::from(&input_dir).join(".tmp");
  std::fs::create_dir_all(&tmp_dir).into_diagnostic().wrap_err(
    format!(
        "Failed to create directories for tmp_dir `{}`. Can not compile files into directory that doesn't exist, exiting.",
        &tmp_dir.display()
    )
  )?;
  let mut stream = UnboundedReceiverStream::new(rx);

  let mut urls = vec![];
  while let Some(msg) = stream.next().await {
    match msg {
      Event::Set(mut info) => {
        // compile something
        info.normalize();
        urls.push(info.slug.clone());
        // dbg!(info);
      }
      Event::End => {
        break;
      }
    }
  }

  let files_by_source_id = compile_src_files(
    &PathBuf::from(input_dir),
    &PathBuf::from(output_dir),
    &import_map,
    &mut cache,
    &tmp_dir,
  )?;
  // render_src_pages()?;
  let file_list = files_by_source_id
    .iter()
    .map(|(_, output_file)| output_file.dest.clone())
    .collect::<Vec<String>>();

  // let _data_from_user = source_data(
  //   &project_root_dir.join("toast.js"),
  //   npm_bin_dir.clone(),
  //   create_pages_pb.clone(),
  // )
  // .await?;
  Ok(urls)
}

// #[instrument(skip(cache))]
fn compile_src_files(
  project_root_dir: &PathBuf,
  output_dir: &PathBuf,
  import_map: &ImportMap,
  cache: &mut cache::Cache,
  tmp_dir: &Path,
) -> miette::Result<HashMap<String, OutputFile>> {
  let files_by_source_id: HashMap<String, OutputFile> =
    WalkDir::new(&project_root_dir.join("src"))
      .into_iter()
      // only scan .js files
      .filter(|result| {
        result.as_ref().map_or(false, |dir_entry| {
          dir_entry
            .file_name()
            .to_str()
            .map(|filename| filename.ends_with(".js"))
            .unwrap_or(false)
        })
      })
      // insert source files into cache and return a
      // HashMap so we can access the entries and such later
      // by source_id
      .fold(HashMap::new(), |mut map, entry| {
        let e = entry.unwrap();
        let path_buf = e.path().to_path_buf();
        let file_stuff = cache.read(path_buf.clone());
        let source_id = e
          .path()
          .strip_prefix(&project_root_dir)
          .unwrap()
          .to_str()
          .unwrap();
        cache.set_source(
          source_id,
          Source {
            source: file_stuff,
            kind: SourceKind::File {
              relative_path: path_buf,
            },
          },
        );

        map.entry(String::from(source_id)).or_insert(
          OutputFile {
            dest: source_id.to_string(),
          },
        );
        map
      });
  for (source_id, output_file) in files_by_source_id.iter()
  {
    compile_js(
      source_id,
      output_file,
      output_dir,
      import_map,
      cache,
      tmp_dir,
    )?;
  }
  Ok(files_by_source_id)
}

fn compile_js(
  source_id: &str,
  output_file: &OutputFile,
  output_dir: &PathBuf,
  import_map: &ImportMap,
  cache: &mut cache::Cache,
  tmp_dir: &Path,
) -> miette::Result<()> {
  let browser_output_file =
    output_dir.join(Path::new(&output_file.dest));
  let js_browser =
    cache.get_js_for_browser(source_id, import_map.clone());
  let file_dir = browser_output_file
    .parent()
    .ok_or(&format!(
      "could not get .parent() directory for `{}`",
      &browser_output_file.display()
    ))
    .unwrap();
  // .into_diagnostic()?;
  std::fs::create_dir_all(&file_dir)
    .into_diagnostic()
    .wrap_err(format!(
      "Failed to create parent directories for `{}`. ",
      &browser_output_file.display()
    ))?;
  let _res =
    std::fs::write(&browser_output_file, js_browser)
      .into_diagnostic()
      .wrap_err(format!(
        "Failed to write browser JS file for `{}`. ",
        &browser_output_file.display()
      ))?;

  let js_node = cache.get_js_for_server(source_id);
  let mut node_output_file = tmp_dir.to_path_buf();
  node_output_file.push(&output_file.dest);
  // node_output_file.set_extension("mjs");
  let file_dir = node_output_file
    .parent()
    .ok_or(format!(
      "could not get .parent() directory for `{}`",
      &node_output_file.display()
    ))
    .unwrap();
  std::fs::create_dir_all(&file_dir)
    .into_diagnostic()
    .wrap_err(format!(
      "Failed to create parent directories for `{}`. ",
      &browser_output_file.display()
    ))?;

  std::fs::write(&node_output_file, js_node)
    .into_diagnostic()
    .wrap_err(format!(
      "Failed to write node JS file for `{}`. ",
      &node_output_file.display()
    ))?;
  Ok(())
}
