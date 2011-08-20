var fs = require('fs');

/** Ожидатель.
 */
var WaitForAll = exports.WaitForAll = function() {
	var target = null, count = 0;
	var update = function() {
		if (count == 0 && target) {
			target();
			target = null;
		}
	};
	this.wait = function() {
		++count;
		return function() {
			--count;
			update();
		};
	};
	this.target = function(t) {
		target = t;
		update();
	};
};

/** Событие
 */
var Event = function() {
	var fired = false, targets = [];
	this.target = function(target) {
		if (fired)
			target();
		else
			targets.push(target);
	};
	this.fire = function() {
		if (fired)
			return;
		fired = true;
		for ( var i = 0; i < targets.length; ++i)
			targets[i]();
		targets = null;
	};
};

/** Класс файла.
 * @param name {String} имя файла
 */
var File = function(name) {
	this.name = name;
	// событие скомпилированности файла (null, если компиляция ещё не началась)
	this.maked = null;
	// тег (сейчас это время модификации файла)
	this.tag = undefined;
	// ожидатель зависимостей
	this.dependencyWaiter = null;
	// максимальная метка времени зависимости
	this.dependencyTag = null;
};

/** обновить тег
 */
File.prototype.updateTag = function(callback) {
	var This = this;
	fs.stat(this.name, function(err, stats) {
		This.tag = err ? null : stats.mtime;
		callback();
	});
};

/** получить, свежий ли файл (то есть нужно ли его компилировать)
 */
File.prototype.isFresh = function() {
	return this.tag && (!this.dependencyTag || this.tag >= this.dependencyTag);
};

/** Начать компиляцию.
 */
File.prototype.beginMaking = function() {
	// если компиляция уже началась, ничего не делать
	if (this.maked)
		return;

	// увеличить счётчик компиляций и баланс
	makesCount++;
	makesBalance++;
	updateProgress();

	var This = this;
	this.maked = new Event();

	// по завершении компиляции уменьшить счётчик компиляций
	this.maked.target(function() {
		makesBalance--;
		updateProgress();
	});

	// обновить тег
	this.updateTag(function() {
		// подобрать компилятор и скомпилировать файл
		callMaker(This);
	});
};

/** Сообщить о завершении компиляции.
 * @param becauseFresh true, если компиляция завершается, потому что файл свежий
 */
File.prototype.ok = function(becauseFresh) {
	var This = this;
	// обновить тег
	this.updateTag(function() {
		if (!becauseFresh)
			fileUpdated(This.name);
		// сообщить о завершении
		This.maked.fire();
	});
};

/** Собрать файл.
 * @param callback {Function} функция, вызываемая по завершении компиляции
 */
File.prototype.make = function(callback) {
	// начать компиляцию
	this.beginMaking();

	// по завершении вызвать callback
	if (callback)
		this.maked.target(callback);
};

/** Собрать файл-зависимость
 * @param fileName(s)... имена файлов
 * @param callback [optional] {Function} функция обратного вызова, чтобы сразу сделать вызов waitDependencies
 */
File.prototype.dep = function() {
	if (!this.dependencyWaiter)
		this.dependencyWaiter = new WaitForAll();
	var This = this;
	for ( var i = 0; i < arguments.length; ++i)
		if (typeof arguments[i] == 'string')
			(function(maked, file) {
				file.make(function() {
					// релаксировать время зависимостей
					if (!This.dependencyTag || This.dependencyTag < file.tag)
						This.dependencyTag = file.tag;
					maked();
				});
			})(this.dependencyWaiter.wait(), getFile(arguments[i]));
		else if (typeof arguments[i] == 'function') {
			if (i != arguments.length - 1)
				throw new Error('callback must be last argument');
			This.waitDeps(arguments[i]);
		} else
			throw new Error('Invalid argument in dependency');
};
/** Продолжить компиляцию, если файл нуждается в обновлении; завершить компиляцию, если нет
 * @param callback {Function} вызывается, только если файл не свежий
 */
File.prototype.refresh = function(callback, moreDeps) {
	if (this.isFresh())
		this.ok(true);
	else
		callback();
};
/** Дождаться компиляции зависимостей
 * @param callback {Function} вызывается, когда все зависимости файла скомпилированы, и файл не свежий
 * @param moreDeps если true, то callback вызывается всегда, даже если файл свежий; это означает, что возможны ещё зависимости
 */
File.prototype.waitDeps = function(callback, moreDeps) {
	var This = this;
	if (this.dependencyWaiter)
		this.dependencyWaiter.target(function() {
			This.dependencyWaiter = null;
			if (moreDeps)
				callback();
			else
				This.refresh(callback);
		});
	else {
		if (moreDeps)
			callback();
		else
			this.refresh(callback);
	}
};

exports.utils = {};

/** Вспомогательная функция для копирования файла.
 */
exports.utils.copyFile = function(source, dest, callback) {
	source = fs.createReadStream(source);
	dest = fs.createWriteStream(dest);
	dest.on('close', callback);
	source.pipe(dest);
};

/** Экранировать строку (для формирования динамической регулярки)
 */
exports.utils.regexpEscape = function(text) {
	return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
};

/** правила компиляции
 */
var rules = [];

/** зарегистрировать компилятор
 * @param re {RegExp} регулярное выражение; не забывать ставить ^ и $; не глобальное!
 * @param make {Function} function(a) - функция-компилятор, a - результат проверки регулярки
 */
exports.rule = function(re, make) {
	if (re.global)
		throw new Error('Global rule regexp is forbidden');
	rules.push({
		re: re,
		make: make
	});
};

/** запустить подходящий компилятор
 */
var callMaker = function(file) {
	for ( var i = 0; i < rules.length; ++i) {
		var rule = rules[i];
		var a = rule.re.exec(file.name);
		if (a) {
			rule.make(a, file);
			return;
		}
	}
	file.refresh(function() {
		throw new Error(file.name + ': no rule');
	});
};

/** кэш файлов
 */
var files = {};

/** получить файл
 */
var getFile = function(fileName) {
	// если файла в кэше нет
	if (!(fileName in files))
		// создать файл
		files[fileName] = new File(fileName);
	// вернуть файл
	return files[fileName];
};

/** Функция, выполняющая компиляцию заданного файла.
 * @param fileName {String} имя файла
 */
exports.make = function(fileName) {
	// скомпилировать файл
	getFile(fileName).make();
};

/** обновить прогресс
 */
var updateProgress = function() {
	// FIXME: код ниже выводит полосу прогресса в консоли,
	// но eclipse не воспринимает \r
	return;
	var count = 32;
	var progress = (makesCount - makesBalance) / makesCount * count;
	var str = '\r';
	for ( var i = 0; i < progress; ++i)
		str += '█';
	for (; i < count; ++i)
		str += '▒';
	process.stdout.write(str);
};

/** список обновлённых файлов
 */
var updatedFiles = [];
/** добавить файл в список обновлённых
 */
var fileUpdated = function(fileName) {
	updatedFiles.push(fileName);
};
/** вывести обновлённые файлы
 */
var printUpdatedFiles = function() {
	process.stdout.write('\n');
	// отсортировать имена
	updatedFiles.sort();
	// сформировать дерево
	var root = {};
	for ( var i = 0; i < updatedFiles.length; ++i) {
		var file = updatedFiles[i];
		var j = file.indexOf('/');
		var lastj = 0;
		var node = root;
		while (j >= 0) {
			var dir = file.substring(lastj + 1, j + 1);
			if (node[dir] === undefined)
				node[dir] = {};
			node = node[dir];

			lastj = j;
			j = file.indexOf('/', j + 1);
		}
		node[file.substr(lastj + 1)] = null;
	}
	// вывести дерево
	var print = function(name, node, level) {
		// если это каталог
		if (node) {
			// получить файлы и каталоги внутри
			var subnames = [];
			for ( var i in node)
				subnames.push(i);
			// если их одно, и это каталог
			if (subnames.length == 1 && node[subnames[0]]) {
				// то передать имя ему и всё (не повышая уровень)
				print(name + subnames[0], node[subnames[0]], level);
				return;
			}
			// напечатать имя каталога
			var str = '';
			for ( var i = 0; i < level; ++i)
				str += '  ';
			str += name;
			console.log(str);
			// отсортировать подымена
			subnames.sort();
			// рекурсивно пройтись по ним
			for ( var i = 0; i < subnames.length; ++i)
				print(subnames[i], node[subnames[i]], level + 1);
		} else {
			// иначе это файл, просто напечатать его
			var str = '';
			for ( var i = 0; i < level; ++i)
				str += '  ';
			str += name;
			console.log(str);
		}
	};
	print('', root, 0);
};

// по завершении процесса проверить, что все компиляторы завершили выполнение
var makesCount = 0;
var makesBalance = 0;
var isError = false;

process.on('exit', function() {
	// вывести обновлённые файлы
	printUpdatedFiles();

	if (makesBalance != 0 && !isError)
		console.error('uncompleted makes');
});

// обработка исключения
process.on('uncaughtException', function(err) {
	// указать, что произошла ошибка, чтобы не выводить лишнее сообщение
	isError = true;
	// вывести информацию
	console.error(err.message);
	// завершить процесс
	process.exit(1);
});
