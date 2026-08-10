//! Anything relating to runtime reflection of type information.

use std::fmt::Display;

use ts_rs::{Config, TS};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodegenType {
    name: String,
}

impl CodegenType {
    pub fn from_type_with_definition<T: TS + 'static + ?Sized>() -> (Self, String) {
        // Generate the declaration, which includes `type ... =`, and any generic
        // parameters.
        let declaration = T::decl(&Config::default());

        // Split the declaration into the name and definition.
        let (name, definition) = declaration.split_once("=").expect("valid TS declaration");

        // Process the definition.
        let definition = definition.strip_suffix(';').unwrap().trim().to_string();

        let name = name.strip_prefix("type").unwrap().trim().to_string();

        (Self::from_name(name), definition)
    }

    pub fn from_type<T: TS + 'static + ?Sized>() -> Self {
        Self::from_name(T::name(&Config::default()))
    }

    fn from_name(s: impl AsRef<str>) -> Self {
        Self {
            name: s.as_ref().to_string(),
        }
    }
}

impl Display for CodegenType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name)
    }
}
